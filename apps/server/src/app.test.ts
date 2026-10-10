import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { PullRequestEvidence } from "./diff.js";
import type { PullRequestMetadata } from "./github.js";
import type { InvestigationContext, TextProvider } from "./providers/types.js";
import { SessionStore } from "./sessions.js";
import { parsePullRequestTarget } from "./targets.js";

let server: Server | undefined;
let store: SessionStore | undefined;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  store?.close();
  server = undefined;
  store = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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
    expect(exchange.headers.get("referrer-policy")).toBe("no-referrer");
    expect(exchange.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const cookie = exchange.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const health = await fetch(`${baseUrl}/api/health`, { headers: { Cookie: cookie } });
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${baseUrl}/api/targets/parse`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ input: target.canonicalUrl }),
    })).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/targets/parse`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ input: target.canonicalUrl }),
    })).status).toBe(403);
  });

  it("generates and resumes a revision-pinned tour", async () => {
    store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence, process.cwd());
    let investigationContext: InvestigationContext | undefined;
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
      async *streamInvestigation(_selection, context) {
        investigationContext = context;
        yield "The pinned evidence is atomic.";
      },
    };
    const app = createApp({}, { sessionStore: store, providers: new Map([["codex", provider]]) });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/api/sessions/${session.id}/tour`;

    const created = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selection: { provider: "codex", model: "codex-default", reasoningEffort: "medium" } }),
    });
    expect(created.status).toBe(202);
    expect(await created.json()).toMatchObject({ generation: { state: "running", scope: "full" } });
    await waitForGeneration(url, "succeeded");

    const resumed = await fetch(url);
    const resumedBody = await resumed.json() as { generated: { headSha: string; anchors: Array<{ id: string }> } };
    expect(resumed.status).toBe(200);
    expect(resumedBody.generated.headSha).toBe(metadata.head.sha);
    expect(resumedBody.generated.anchors.map((anchor) => anchor.id)).toContain("line_new-counter");

    const investigated = await fetch(`${url.replace(/\/tour$/, "")}/investigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selection: { provider: "codex", model: "codex-default", reasoningEffort: "medium" },
        scope: "full",
        stopId: "atomic-counter",
        question: "Can concurrent calls race?",
        context: { stop: { title: "Invented client evidence" } },
      }),
    });
    expect(investigated.status).toBe(200);
    expect(await investigated.text()).toContain("The pinned evidence is atomic.");
    expect(investigationContext?.stop.title).toBe("Counter update");
    expect(investigationContext?.stop.evidence.flatMap((item) => item.lines).map((line) => line.content))
      .toContain("return redis.incr(key)");
  });

  it("polls elapsed generation status and coalesces duplicate starts", async () => {
    store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence, process.cwd());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let generationCalls = 0;
    const provider: TextProvider = {
      id: "codex",
      generationTimeoutMs: 600_000,
      async generateTour(_selection, input) {
        generationCalls += 1;
        await gate;
        return {
          summary: "The counter update is atomic.",
          stops: [{
            id: "atomic-counter", title: "Counter update", summary: "Redis performs the increment.", purpose: "Verify behavior.",
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
    const input = { selection: { provider: "codex", model: "codex-default", reasoningEffort: "medium" } };

    const started = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ generation: { state: "running", scope: "full", timeoutMs: 600_000 } });

    const status = await (await fetch(`${url}-status`)).json() as { generation: { state: string; elapsedMs: number; timeoutMs: number } };
    expect(status.generation).toMatchObject({ state: "running", timeoutMs: 600_000 });
    expect(status.generation.elapsedMs).toBeGreaterThanOrEqual(0);

    const duplicate = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    expect(duplicate.status).toBe(202);

    const conflictingScope = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, scope: "update" }),
    });
    expect(conflictingScope.status).toBe(409);

    const conflictingSelection = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selection: { ...input.selection, reasoningEffort: "high" } }),
    });
    expect(conflictingSelection.status).toBe(409);

    release();
    const completed = await waitForGeneration(url, "succeeded");
    expect(completed).toMatchObject({ state: "succeeded", scope: "full", timeoutMs: 600_000 });
    expect(generationCalls).toBe(1);
  });

  it("invalidates a persisted tour when repository instructions change", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wingdiff-app-context-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "AGENTS.md"), "Review concurrency carefully.\n", "utf8");
    store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence, root);
    const provider: TextProvider = {
      id: "codex",
      async generateTour(_selection, input) {
        return {
          summary: "The counter update is atomic.",
          stops: [{
            id: "atomic-counter", title: "Counter update", summary: "Redis performs the increment.", purpose: "Verify behavior.",
            anchorIds: [input.fileAnchorIds[0]!, "line_new-counter"],
            claims: [{ text: "The new path calls INCR.", kind: "fact", confidence: "high", anchorIds: ["line_new-counter"] }],
            prompts: [], finding: null,
          }],
        };
      },
      async *streamInvestigation() { yield ""; },
    };
    const app = createApp({}, { sessionStore: store, providers: new Map([["codex", provider]]), cwd: root });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/api/sessions/${session.id}/tour`;
    const created = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selection: { provider: "codex", model: "codex-default", reasoningEffort: "medium" } }),
    });
    expect(created.status).toBe(202);
    await waitForGeneration(url, "succeeded");

    await writeFile(path.join(root, "AGENTS.md"), "Review failure handling carefully.\n", "utf8");
    const stale = await fetch(url);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: expect.stringMatching(/context changed/) });
  });

  it("stages only comments anchored to the pinned diff", async () => {
    store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence, process.cwd());
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
      body: JSON.stringify({ body: "The implementation looks ready.", event: "APPROVE", scope: "full", acknowledgeApprovalRisks: true }),
    });
    expect(submitted.status).toBe(201);
    expect(publishedComments).toBe(0);
    expect(await (await fetch(submissionUrl)).json()).toMatchObject({ submission: { githubReviewId: 91, event: "APPROVE" } });
  });

  it("persists a session investigation notebook", async () => {
    store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence, process.cwd());
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

  it("persists scope-aware review progress", async () => {
    store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence, process.cwd());
    saveFixtureTour(store, session.id, "full");
    const app = createApp({}, { sessionStore: store, providers: new Map() });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/api/sessions/${session.id}/progress`;

    const saved = await fetch(url, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "full", activeStopId: "atomic-counter",
        change: { stopId: "atomic-counter", status: "understood" },
      }),
    });
    expect(saved.status).toBe(200);
    expect(await (await fetch(url)).json()).toEqual({ progress: {
      activeScope: "full",
      activeStopIds: { full: "atomic-counter", update: null },
      scopes: { full: { "atomic-counter": "understood" }, update: {} },
    } });

    const checkpoint = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/checkpoint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "full",
        coverage: { "atomic-counter": "understood" },
        findingRevisions: [{ findingId: "invented", title: "Invented", severity: "high", state: "new", summary: "No." }],
      }),
    });
    expect(checkpoint.status).toBe(201);
    expect(await checkpoint.json()).toMatchObject({ checkpoint: {
      scope: "full",
      coverage: { "full-atomic-counter": "understood" },
      findingRevisions: [],
    } });

    const stale = await fetch(url, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "full", activeStopId: "stale-stop" }),
    });
    expect(stale.status).toBe(400);
  });

  it("returns a JSON error when a saved review's GitLab host is no longer trusted", async () => {
    vi.stubEnv("WINGDIFF_GITLAB_HOSTS", "gitlab.example.com");
    store = new SessionStore(":memory:");
    const gitLabTarget = parsePullRequestTarget("https://gitlab.example.com/acme/service/-/merge_requests/7");
    const session = store.upsertReadySession(gitLabTarget, metadata, evidence, process.cwd());
    vi.stubEnv("WINGDIFF_GITLAB_HOSTS", "");
    const app = createApp({}, { sessionStore: store, providers: new Map(), cwd: process.cwd() });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}`);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: "This saved review is for gitlab.example.com, which is not listed in WINGDIFF_GITLAB_HOSTS. Add it to reopen the review.",
    });
  });

  it("previews and persists the exact model-context boundary", async () => {
    store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence, process.cwd());
    const app = createApp({}, { sessionStore: store, providers: new Map(), cwd: process.cwd() });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/api/sessions/${session.id}/context`;

    const preview = await (await fetch(`${url}?scope=full`)).json() as { manifest: { includedFiles: number; promptPreview: string } };
    expect(preview.manifest.includedFiles).toBe(1);
    expect(preview.manifest.promptPreview).toContain("return redis.incr(key)");

    const saved = await fetch(url, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "full", excludedPatterns: ["src/**"] }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ manifest: { includedFiles: 0, excludedFiles: 1 } });
  });
});

async function waitForGeneration(url: string, state: "succeeded" | "failed") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${url}-status`);
    const body = await response.json() as { generation: { state: string; error?: string } };
    if (body.generation.state === state) return body.generation;
    if (body.generation.state === "failed") throw new Error(body.generation.error ?? "Generation failed.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Generation did not reach ${state}.`);
}

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

function saveFixtureTour(store: SessionStore, sessionId: string, scope: "full" | "update") {
  store.saveTour(sessionId, scope, { provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" }, evidence.baseSha, evidence.headSha, {
    summary: "The counter update moves to Redis.",
    findingRevisions: [],
    stops: [{
      id: "atomic-counter", title: "Counter update", summary: "Redis performs the increment.", purpose: "Verify behavior.",
      anchorIds: ["line_new-counter"],
      claims: [{ text: "The new path calls INCR.", kind: "fact", confidence: "high", anchorIds: ["line_new-counter"] }],
      prompts: [],
    }],
  });
}
