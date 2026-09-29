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
