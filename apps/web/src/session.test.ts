import { describe, expect, it } from "vitest";
import {
  checkpointFindings,
  evidenceBlocks,
  generatedTourStops,
  revisionStopIndex,
  type AcquiredReviewSession,
  type GeneratedSessionTour,
  type ReviewCheckpoint,
} from "./session";

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

  it("carries finding continuity into the next checkpoint", () => {
    const acquired = session();
    const generated = generatedTour(acquired, "update");
    generated.tour.findingRevisions = [{
      findingId: "counter-race",
      state: "appears-addressed",
      summary: "The increment is now atomic in Redis.",
      anchorIds: ["line-new"],
    }];
    const baseline: ReviewCheckpoint = {
      reviewedHeadSha: "c".repeat(40), completedAt: "2026-09-29T11:00:00Z", scope: "full", coverage: {},
      findingRevisions: [{ findingId: "counter-race", title: "Counter can race", severity: "high", state: "new", summary: "Read and write are separate.", pathHints: ["src/counter.ts"] }],
    };

    expect(revisionStopIndex(generated, ["line-new"])).toBe(0);
    expect(checkpointFindings(generated, generatedTourStops(acquired, generated), baseline)).toEqual([{
      findingId: "counter-race",
      title: "Counter can race",
      severity: "high",
      state: "appears-addressed",
      summary: "The increment is now atomic in Redis.",
      pathHints: ["src/counter.ts"],
    }]);
  });

  it("records new findings alongside terminal finding history", () => {
    const acquired = session();
    const generated = generatedTour(acquired, "update");
    generated.tour.stops[0]!.finding = {
      title: "Expiry may be lost", body: "INCR does not establish the expected expiry.", severity: "medium",
      category: "Correctness", anchorIds: ["line-new"], suggestedComment: "Where is expiry preserved?",
    };
    const baseline: ReviewCheckpoint = {
      reviewedHeadSha: "c".repeat(40), completedAt: "2026-09-29T11:00:00Z", scope: "full", coverage: {},
      findingRevisions: [{ findingId: "old-race", title: "Old race", severity: "high", state: "resolved", summary: "Reviewer confirmed the fix.", pathHints: ["src/counter.ts"] }],
    };

    expect(checkpointFindings(generated, generatedTourStops(acquired, generated), baseline)).toEqual([
      baseline.findingRevisions[0],
      { findingId: "atomic-counter-finding", title: "Expiry may be lost", severity: "medium", state: "new", summary: "INCR does not establish the expected expiry.", pathHints: ["src/counter.ts"] },
    ]);
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
