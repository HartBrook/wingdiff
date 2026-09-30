import { describe, expect, it } from "vitest";
import type { PullRequestEvidence } from "./diff.js";
import type { PullRequestMetadata } from "./github.js";
import type { ModelSelection, TextProvider } from "./providers/types.js";
import { SessionStore } from "./sessions.js";
import { parsePullRequestTarget } from "./targets.js";
import { generateSessionTour, getSessionTour } from "./tourService.js";

const selection: ModelSelection = { provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" };

describe("session tour generation", () => {
  it("validates, persists, and restores grounded output", async () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence);
    const provider: TextProvider = {
      id: "codex",
      async generateTour(_selection, input) {
        return {
          summary: "The change makes the counter update atomic.",
          stops: [{
            id: "atomic-counter",
            title: "Counter update becomes atomic",
            summary: "The new path uses one Redis operation.",
            purpose: "Verify concurrency behavior.",
            anchorIds: [input.fileAnchorIds[0]!, "line_new-counter"],
            claims: [{
              text: "The new path calls INCR.",
              kind: "fact",
              confidence: "high",
              anchorIds: ["line_new-counter"],
            }],
            prompts: [],
            finding: null,
          }],
        };
      },
      async *streamInvestigation() { yield ""; },
    };

    const generated = await generateSessionTour(session, selection, provider, store);

    expect(generated.tour.stops[0]?.finding).toBeUndefined();
    expect(generated.anchors.map((anchor) => anchor.id)).toContain("line_new-counter");
    expect(generated.contextFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(store.getTour(session.id)?.contextManifest).toMatchObject({
      fingerprint: generated.contextFingerprint,
      baseSha: evidence.baseSha,
      headSha: evidence.headSha,
    });
    expect(store.getTour(session.id)?.anchors).toEqual(generated.anchors);
    expect(getSessionTour(session, store)).toEqual(generated);
    store.close();
  });

  it("rejects provider output that invents evidence", async () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence);
    const provider: TextProvider = {
      id: "codex",
      async generateTour() {
        return {
          summary: "Unsupported output.",
          stops: [{
            id: "invented",
            title: "Invented behavior",
            summary: "This is not grounded.",
            purpose: "Demonstrate rejection.",
            anchorIds: ["line_invented"],
            claims: [{ text: "Invented.", kind: "fact", confidence: "high", anchorIds: ["line_invented"] }],
            prompts: [],
          }],
        };
      },
      async *streamInvestigation() { yield ""; },
    };

    await expect(generateSessionTour(session, selection, provider, store)).rejects.toThrow("unknown evidence anchor");
    expect(store.getTour(session.id)).toBeUndefined();
    store.close();
  });

  it("generates an independent tour from reviewed-head update evidence", async () => {
    const store = new SessionStore(":memory:");
    const baselineMetadata = { ...metadata, head: { ref: "feature", sha: "c".repeat(40) } };
    const baseline = store.upsertReadySession(target, baselineMetadata, { ...evidence, headSha: baselineMetadata.head.sha });
    store.saveCheckpoint(baseline.id, {
      reviewedHeadSha: baseline.metadata.head.sha,
      completedAt: "2026-09-29T12:10:00Z",
      scope: "full",
      coverage: { counter: "understood" },
      findingRevisions: [{
        findingId: "counter-race",
        title: "Counter updates can race",
        severity: "high",
        state: "new",
        summary: "The earlier path used a read-modify-write sequence.",
        pathHints: ["src/counter.ts"],
      }],
    });
    const current = store.upsertReadySession(target, metadata, evidence);
    store.saveReviewUpdate(current.id, baseline.id, {
      ...evidence,
      baseSha: baselineMetadata.head.sha,
      headSha: current.metadata.head.sha,
    });
    let suppliedBaseSha = "";
    const provider: TextProvider = {
      id: "codex",
      async generateTour(_selection, input) {
        suppliedBaseSha = input.pullRequest.baseSha;
        expect(input.priorFindings.map((finding) => finding.id)).toEqual(["counter-race"]);
        return {
          summary: "Only the counter changed since review.",
          findingRevisions: [{
            findingId: "counter-race",
            state: "appears-addressed",
            summary: "The current change uses one Redis operation.",
            anchorIds: ["line_new-counter"],
          }],
          stops: [{
            id: "counter-update", title: "Counter follow-up", summary: "The follow-up adjusts the counter.", purpose: "Recheck the changed area.",
            anchorIds: [input.fileAnchorIds[0]!, "line_new-counter"],
            claims: [{ text: "The counter line changed.", kind: "fact", confidence: "high", anchorIds: ["line_new-counter"] }],
            prompts: [], finding: null,
          }],
        };
      },
      async *streamInvestigation() { yield ""; },
    };

    const generated = await generateSessionTour(current, selection, provider, store, "update");

    expect(suppliedBaseSha).toBe(baselineMetadata.head.sha);
    expect(generated).toMatchObject({ scope: "update", baseSha: baselineMetadata.head.sha, headSha: metadata.head.sha });
    expect(getSessionTour(current, store, "update")).toEqual(generated);
    expect(store.getTour(current.id, "full")).toBeUndefined();
    store.close();
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
