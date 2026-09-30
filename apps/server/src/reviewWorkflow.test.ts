import { describe, expect, it } from "vitest";
import type { PullRequestEvidence } from "./diff.js";
import type { PullRequestMetadata } from "./github.js";
import { checkpointCoverageForSession, checkpointFindingsForSession } from "./reviewWorkflow.js";
import { SessionStore } from "./sessions.js";
import { parsePullRequestTarget } from "./targets.js";

describe("review workflow invariants", () => {
  it("requires exact current-tour coverage and derives findings on the server", () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata("b"), evidence("a", "b", "current"));
    saveTour(store, session.id, "full", session.evidence, [], true);

    expect(() => checkpointCoverageForSession(session, store, "full", {})).toThrow(/incomplete/);
    expect(() => checkpointCoverageForSession(session, store, "full", { "atomic-counter": "understood", stale: "understood" }))
      .toThrow(/stale or unknown/);
    expect(checkpointCoverageForSession(session, store, "full", { "atomic-counter": "flagged" }))
      .toEqual({ "full-atomic-counter": "flagged" });
    expect(checkpointFindingsForSession(session, store, "full")).toMatchObject([{
      findingId: "atomic-counter-finding",
      title: "Expiry may be lost",
      severity: "high",
      state: "new",
    }]);
    store.close();
  });

  it("carries baseline coverage and finding continuity through an update checkpoint", () => {
    const store = new SessionStore(":memory:");
    const baseline = store.upsertReadySession(target, metadata("b"), evidence("a", "b", "baseline"));
    store.saveCheckpoint(baseline.id, {
      reviewedHeadSha: baseline.metadata.head.sha,
      completedAt: "2026-09-29T12:00:00Z",
      scope: "full",
      coverage: { "full-atomic-counter": "understood" },
      findingRevisions: [{
        findingId: "atomic-counter-finding", title: "Counter can race", severity: "high", state: "new",
        summary: "Read and write are separate.", pathHints: ["src/counter.ts"],
      }],
    });
    const current = store.upsertReadySession(target, metadata("c"), evidence("a", "c", "current"));
    const updateEvidence = evidence("b", "c", "update");
    store.saveReviewUpdate(current.id, baseline.id, updateEvidence);
    saveTour(store, current.id, "update", updateEvidence, [{
      findingId: "atomic-counter-finding",
      state: "appears-addressed",
      summary: "The update is atomic now.",
      anchorIds: ["line_update"],
    }], false);

    expect(checkpointCoverageForSession(current, store, "update", { "atomic-counter": "understood" })).toEqual({
      "full-atomic-counter": "understood",
      "update-atomic-counter": "understood",
    });
    expect(checkpointFindingsForSession(current, store, "update")).toMatchObject([{
      findingId: "atomic-counter-finding",
      state: "appears-addressed",
      summary: "The update is atomic now.",
      pathHints: ["src/counter.ts"],
    }]);
    store.close();
  });
});

const target = parsePullRequestTarget("https://github.com/openai/codex/pull/42");

function metadata(head: string): PullRequestMetadata {
  return {
    number: 42, repository: "openai/codex", url: target.canonicalUrl, title: "Counter", body: "",
    author: { login: "octocat" }, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature", sha: head.repeat(40) },
    additions: 1, deletions: 1, filesChanged: 1, commits: [], checks: { passed: 1, failed: 0, pending: 0, total: 1 },
    reviews: { count: 0 }, state: "OPEN", draft: false, updatedAt: "2026-09-29T12:00:00Z",
  };
}

function evidence(base: string, head: string, fingerprint: string): PullRequestEvidence {
  return {
    baseSha: base.repeat(40), headSha: head.repeat(40), additions: 1, deletions: 0,
    files: [{
      path: "src/counter.ts", status: "modified", additions: 1, deletions: 0,
      hunks: [{ header: "@@ -1 +1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: [{ kind: "addition", content: "return incrementCounter(key);", newLine: 1, fingerprint }] }],
    }],
  };
}

function saveTour(
  store: SessionStore,
  sessionId: string,
  scope: "full" | "update",
  tourEvidence: PullRequestEvidence,
  findingRevisions: Array<{ findingId: string; state: "appears-addressed"; summary: string; anchorIds: string[] }>,
  withFinding: boolean,
) {
  const lineAnchor = `line_${tourEvidence.files[0]!.hunks[0]!.lines[0]!.fingerprint}`;
  store.saveTour(sessionId, scope, { provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" },
    tourEvidence.baseSha, tourEvidence.headSha, {
      summary: "The counter changes.", findingRevisions,
      stops: [{
        id: "atomic-counter", title: "Counter update", summary: "The counter changes.", purpose: "Verify behavior.",
        anchorIds: [lineAnchor],
        claims: [{ text: "The counter changes.", kind: "fact", confidence: "high", anchorIds: [lineAnchor] }],
        prompts: [],
        ...(withFinding ? { finding: {
          title: "Expiry may be lost", body: "The expiry behavior is unclear.", severity: "high" as const,
          category: "Correctness", anchorIds: [lineAnchor], suggestedComment: "Where is expiry preserved?",
        } } : {}),
      }],
    });
}
