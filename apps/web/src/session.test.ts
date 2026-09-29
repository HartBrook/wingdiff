import { describe, expect, it } from "vitest";
import { evidenceBlocks, type AcquiredReviewSession } from "./session";

describe("acquired session evidence", () => {
  it("adapts pinned evidence to the existing diff renderer", () => {
    const blocks = evidenceBlocks(session());
    expect(blocks).toMatchObject([{
      path: "src/counter.ts",
      language: "TypeScript",
      startLine: 2,
      endLine: 3,
      label: "Modified · +1 −1",
      lines: [
        { kind: "header", content: "@@ -2 +2 @@" },
        { kind: "deletion", oldLine: 2, content: "return current + 1;" },
        { kind: "addition", newLine: 3, content: "return redis.incr(key);" },
      ],
    }]);
  });
});

function session(): AcquiredReviewSession {
  return {
    id: "session-1",
    target: { owner: "openai", repository: "codex", number: 42, canonicalUrl: "https://github.com/openai/codex/pull/42", label: "openai/codex#42", source: "url" },
    metadata: {
      number: 42, repository: "openai/codex", url: "https://github.com/openai/codex/pull/42", title: "Counter", body: "",
      author: { login: "octocat" }, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature", sha: "b".repeat(40) },
      additions: 1, deletions: 1, filesChanged: 1, commits: [], checks: { passed: 0, failed: 0, pending: 0, total: 0 },
      reviews: { count: 0 }, state: "OPEN", draft: false, updatedAt: "2026-09-29T12:00:00Z",
    },
    evidence: {
      baseSha: "a".repeat(40), headSha: "b".repeat(40), additions: 1, deletions: 1,
      files: [{
        oldPath: "src/counter.ts", path: "src/counter.ts", status: "modified", additions: 1, deletions: 1,
        hunks: [{
          header: "@@ -2 +2 @@", oldStart: 2, oldLines: 1, newStart: 2, newLines: 1,
          lines: [
            { kind: "deletion", content: "return current + 1;", oldLine: 2, fingerprint: "old" },
            { kind: "addition", content: "return redis.incr(key);", newLine: 3, fingerprint: "new" },
          ],
        }],
      }],
    },
    status: "ready", createdAt: "2026-09-29T12:00:00Z", updatedAt: "2026-09-29T12:00:00Z",
  };
}
