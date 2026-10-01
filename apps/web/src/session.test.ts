import { describe, expect, it } from "vitest";
import {
  evidenceBlocks,
  formatElapsedTime,
  generatedTourStops,
  revisionStopIndex,
  type AcquiredReviewSession,
  type GeneratedSessionTour,
} from "./session";

describe("acquired session evidence", () => {
  it("formats generation elapsed time for polling feedback", () => {
    expect(formatElapsedTime(999)).toBe("0s");
    expect(formatElapsedTime(65_900)).toBe("1m 5s");
    expect(formatElapsedTime(600_000)).toBe("10m 0s");
  });

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

  it("adapts a grounded generated tour and emphasizes exact anchors", () => {
    const acquired = session();
    const generated: GeneratedSessionTour = {
      sessionId: acquired.id,
      scope: "full",
      selection: { provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" },
      baseSha: acquired.metadata.base.sha,
      headSha: acquired.metadata.head.sha,
      tour: {
        summary: "The counter update is now atomic.",
        findingRevisions: [],
        stops: [{
          id: "atomic-counter", title: "Counter update", summary: "Redis performs the increment.", purpose: "Check concurrency.",
          anchorIds: ["file-counter", "line-new"],
          claims: [{ text: "The new path calls INCR.", kind: "fact", confidence: "high", anchorIds: ["line-new"] }],
          prompts: ["Does the client preserve atomicity?"],
        }],
      },
      anchors: [
        { id: "file-counter", path: "src/counter.ts", kind: "file" },
        { id: "line-new", path: "src/counter.ts", kind: "addition", newLine: 3, content: "return redis.incr(key);" },
      ],
      createdAt: "2026-09-29T12:01:00Z", updatedAt: "2026-09-29T12:01:00Z",
    };

    const stops = generatedTourStops(acquired, generated);

    expect(stops[0]).toMatchObject({
      id: "atomic-counter",
      eyebrow: "Code change",
      evidence: [{ path: "src/counter.ts" }],
      claims: [{ evidenceIds: ["session-0-src/counter.ts"] }],
    });
    expect(stops[0]?.evidence[0]?.lines.find((line) => line.newLine === 3)?.emphasized).toBe(true);
  });

  it("limits each stop to a focused window around its exact anchors", () => {
    const acquired = session();
    const leadingContext = Array.from({ length: 12 }, (_, index) => ({
      kind: "context" as const,
      content: `const context${index + 1} = true;`,
      oldLine: index + 1,
      newLine: index + 1,
      fingerprint: `context-${index + 1}`,
    }));
    acquired.evidence.files[0]!.hunks = [{
      header: "@@ -1,13 +1,13 @@",
      oldStart: 1,
      oldLines: 13,
      newStart: 1,
      newLines: 13,
      lines: [...leadingContext, { kind: "addition", content: "return redis.incr(key);", newLine: 13, fingerprint: "new" }],
    }, {
      header: "@@ -100 +100 @@",
      oldStart: 100,
      oldLines: 1,
      newStart: 100,
      newLines: 1,
      lines: [{ kind: "context", content: "unrelated();", oldLine: 100, newLine: 100, fingerprint: "unrelated" }],
    }];
    const generated = generatedTour(acquired, "full");
    generated.anchors[1] = { id: "line-new", path: "src/counter.ts", kind: "addition", newLine: 13, content: "return redis.incr(key);" };

    const block = generatedTourStops(acquired, generated)[0]!.evidence[0]!;

    expect(block.lines.some((line) => line.content === "const context1 = true;")).toBe(false);
    expect(block.lines.some((line) => line.content === "unrelated();")).toBe(false);
    expect(block.lines.filter((line) => line.kind !== "header")).toHaveLength(6);
    expect(block.lines.find((line) => line.newLine === 13)?.emphasized).toBe(true);
  });

  it("locates the stop carrying a revised finding", () => {
    const acquired = session();
    const generated = generatedTour(acquired, "update");
    generated.tour.findingRevisions = [{
      findingId: "counter-race",
      state: "appears-addressed",
      summary: "The increment is now atomic in Redis.",
      anchorIds: ["line-new"],
    }];
    expect(revisionStopIndex(generated, ["line-new"])).toBe(0);
  });
});

function generatedTour(acquired: AcquiredReviewSession, scope: GeneratedSessionTour["scope"]): GeneratedSessionTour {
  return {
    sessionId: acquired.id,
    scope,
    selection: { provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" },
    baseSha: acquired.metadata.base.sha,
    headSha: acquired.metadata.head.sha,
    tour: {
      summary: "The counter update is now atomic.",
      findingRevisions: [],
      stops: [{
        id: "atomic-counter", title: "Counter update", summary: "Redis performs the increment.", purpose: "Check concurrency.",
        anchorIds: ["file-counter", "line-new"],
        claims: [{ text: "The new path calls INCR.", kind: "fact", confidence: "high", anchorIds: ["line-new"] }],
        prompts: [],
      }],
    },
    anchors: [
      { id: "file-counter", path: "src/counter.ts", kind: "file" },
      { id: "line-new", path: "src/counter.ts", kind: "addition", newLine: 3, content: "return redis.incr(key);" },
    ],
    createdAt: "2026-09-29T12:01:00Z", updatedAt: "2026-09-29T12:01:00Z",
  };
}

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
