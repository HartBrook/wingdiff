import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { PullRequestEvidence } from "./diff.js";
import type { PullRequestMetadata } from "./github.js";
import type { TextProvider } from "./providers/types.js";
import { SessionStore } from "./sessions.js";
import { parsePullRequestTarget } from "./targets.js";

let server: Server | undefined;
let store: SessionStore | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  store?.close();
  server = undefined;
  store = undefined;
});

describe("generated tour API", () => {
  it("exchanges a launch token for an HTTP-only cookie and protects APIs", async () => {
    store = new SessionStore(":memory:");
    const app = createApp({}, { sessionStore: store, providers: new Map(), authToken: "a".repeat(43) });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(401);
    const exchange = await fetch(`${baseUrl}/?demo=1&wingdiff_token=${"a".repeat(43)}`, { redirect: "manual" });
    expect(exchange.status).toBe(302);
    expect(exchange.headers.get("location")).toBe("/?demo=1");
    const cookie = exchange.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect((await fetch(`${baseUrl}/api/health`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/targets/parse`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ input: target.canonicalUrl }),
    })).status).toBe(403);
  });

  it("generates and resumes a revision-pinned tour", async () => {
    store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence);
    const provider: TextProvider = {
      id: "codex",
      async generateTour(_selection, input) {
        return {
          summary: "The counter update moves to one Redis operation.",
          stops: [{
            id: "atomic-counter", title: "Counter update", summary: "Redis performs the increment.", purpose: "Verify concurrent behavior.",
            anchorIds: [input.fileAnchorIds[0]!, "line_new-counter"],
            claims: [{ text: "The new path calls INCR.", kind: "fact", confidence: "high", anchorIds: ["line_new-counter"] }],
            prompts: [], finding: null,
          }],
        };
      },
      async *streamInvestigation() { yield ""; },
    };
    const app = createApp({}, { sessionStore: store, providers: new Map([["codex", provider]]) });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/api/sessions/${session.id}/tour`;

    const created = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selection: { provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" } }),
    });
    const createdBody = await created.json() as { generated: { headSha: string; anchors: Array<{ id: string }> } };
    expect(created.status).toBe(201);
    expect(createdBody.generated.headSha).toBe(metadata.head.sha);
    expect(createdBody.generated.anchors.map((anchor) => anchor.id)).toContain("line_new-counter");

    const resumed = await fetch(url);
    const resumedBody = await resumed.json();
    expect(resumed.status).toBe(200);
    expect(resumedBody).toEqual(createdBody);
  });

  it("stages only comments anchored to the pinned diff", async () => {
    store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence);
    let publishedComments = 0;
    const app = createApp({}, {
      sessionStore: store,
      providers: new Map(),
      reviewSubmissionDependencies: {
        readMetadata: async () => metadata,
        publishReview: async (_target, _cwd, _headSha, _draft, comments) => {
          publishedComments = comments.length;
          return { id: 91, url: "https://github.com/openai/codex/pull/42#pullrequestreview-91", state: "APPROVED" };
        },
      },
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/api/sessions/${session.id}/comments`;
    const input = {
      stopId: "atomic-counter", evidenceId: "session-0-src/counter.ts", path: "src/counter.ts",
      side: "RIGHT", startLine: 2, endLine: 2, body: "Does this preserve expiry?",
      severity: "medium", fingerprint: "new-counter",
    };

    const created = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    const createdBody = await created.json() as { comment: { id: string } };
    expect(created.status).toBe(201);

    const listed = await fetch(url);
    expect(await listed.json()).toMatchObject({ comments: [{ ...input, id: createdBody.comment.id }] });

    const stale = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, fingerprint: "stale" }),
    });
    expect(stale.status).toBe(400);

    const removed = await fetch(`${url}/${createdBody.comment.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);

    const draftUrl = `http://127.0.0.1:${port}/api/sessions/${session.id}/review-draft`;
    const savedDraft = await fetch(draftUrl, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "The implementation looks ready.", event: "APPROVE" }),
    });
    expect(savedDraft.status).toBe(200);
    expect(await (await fetch(draftUrl)).json()).toMatchObject({
      draft: { body: "The implementation looks ready.", event: "APPROVE" },
    });

    const submissionUrl = `http://127.0.0.1:${port}/api/sessions/${session.id}/review-submission`;
    const submitted = await fetch(submissionUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "The implementation looks ready.", event: "APPROVE" }),
    });
    expect(submitted.status).toBe(201);
    expect(publishedComments).toBe(0);
    expect(await (await fetch(submissionUrl)).json()).toMatchObject({ submission: { githubReviewId: 91, event: "APPROVE" } });
  });

  it("persists a session investigation notebook", async () => {
    store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence);
    const app = createApp({}, { sessionStore: store, providers: new Map() });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/api/sessions/${session.id}/investigations`;

    const created = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stopId: "atomic-counter", evidenceId: "session-0-src/counter.ts", question: "Can this race?",
        provider: "codex", model: "gpt-6-sol",
      }),
    });
    const createdBody = await created.json() as { entry: { id: string; status: string } };
    expect(created.status).toBe(201);
    expect(createdBody.entry.status).toBe("streaming");

    const saved = await fetch(`${url}/${createdBody.entry.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "The increment is atomic.", status: "complete" }),
    });
    expect(saved.status).toBe(200);
    expect(await (await fetch(url)).json()).toMatchObject({ entries: [{
      id: createdBody.entry.id, answer: "The increment is atomic.", status: "complete",
    }] });

    const invalid = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stopId: "atomic-counter", evidenceId: "evidence", question: "?", provider: "other", model: "x" }),
    });
    expect(invalid.status).toBe(400);
  });
});

const target = parsePullRequestTarget("https://github.com/openai/codex/pull/42");
const metadata = {
  number: 42, repository: "openai/codex", url: target.canonicalUrl, title: "Atomic counter", body: "Fix concurrent updates.",
  author: { login: "octocat" }, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature", sha: "b".repeat(40) },
  additions: 1, deletions: 1, filesChanged: 1, commits: [], checks: { passed: 1, failed: 0, pending: 0, total: 1 }, reviews: { count: 0 },
  state: "OPEN", draft: false, updatedAt: "2026-09-29T12:00:00Z",
} satisfies PullRequestMetadata;
const evidence = {
  baseSha: metadata.base.sha, headSha: metadata.head.sha, additions: 1, deletions: 1,
  files: [{ oldPath: "src/counter.ts", path: "src/counter.ts", status: "modified", additions: 1, deletions: 1, hunks: [{
    header: "@@ -2 +2 @@", oldStart: 2, oldLines: 1, newStart: 2, newLines: 1,
    lines: [
      { kind: "deletion", content: "return value + 1", oldLine: 2, fingerprint: "old-counter" },
      { kind: "addition", content: "return redis.incr(key)", newLine: 2, fingerprint: "new-counter" },
    ],
  }] }],
} satisfies PullRequestEvidence;
