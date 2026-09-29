import { describe, expect, it } from "vitest";
import type { PullRequestEvidence } from "./diff.js";
import type { PullRequestMetadata } from "./github.js";
import { buildTourGenerationInput, buildTourPrompt, validateGeneratedTour } from "./tour.js";

const metadata = {
  number: 42, repository: "openai/codex", url: "https://github.com/openai/codex/pull/42", title: "Atomic counter", body: "Fix concurrent updates.",
  author: { login: "octocat" }, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature", sha: "b".repeat(40) },
  additions: 2, deletions: 1, filesChanged: 2, commits: [], checks: { passed: 1, failed: 0, pending: 0, total: 1 }, reviews: { count: 0 },
  state: "OPEN", draft: false, updatedAt: "2026-09-29T12:00:00Z",
} satisfies PullRequestMetadata;

const evidence = {
  baseSha: "a".repeat(40), headSha: "b".repeat(40), additions: 2, deletions: 1,
  files: [
    { oldPath: "src/counter.ts", path: "src/counter.ts", status: "modified", additions: 1, deletions: 1, hunks: [{ header: "@@ -2 +2 @@", oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: [
      { kind: "deletion", content: "return value + 1", oldLine: 2, fingerprint: "old-counter" },
      { kind: "addition", content: "return redis.incr(key)", newLine: 2, fingerprint: "new-counter" },
    ] }] },
    { path: "tests/counter.test.ts", status: "added", additions: 1, deletions: 0, hunks: [{ header: "@@ -0,0 +1 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [
      { kind: "addition", content: "expect(await increment()).toBe(1)", newLine: 1, fingerprint: "test-counter" },
    ] }] },
  ],
} satisfies PullRequestEvidence;

describe("generated tour contract", () => {
  it("builds a model manifest entirely from validated evidence", () => {
    const input = buildTourGenerationInput(metadata, evidence);
    expect(input.fileAnchorIds).toHaveLength(2);
    expect(input.anchors.map((anchor) => anchor.id)).toContain("line_new-counter");
    const prompt = buildTourPrompt(input);
    expect(prompt).toContain("FILE src/counter.ts");
    expect(prompt).toContain("line_new-counter\tnew:2\t+return redis.incr(key)");
  });

  it("uses the evidence revision pair for an update-scoped prompt", () => {
    const updateEvidence = { ...evidence, baseSha: "c".repeat(40) };
    const input = buildTourGenerationInput(metadata, updateEvidence);

    expect(input.pullRequest.baseSha).toBe("c".repeat(40));
    expect(input.pullRequest.headSha).toBe(metadata.head.sha);
  });

  it("accepts concise, fully grounded stops", () => {
    const input = buildTourGenerationInput(metadata, evidence);
    const tour = validateGeneratedTour(validTour(input.fileAnchorIds), input);
    expect(tour.stops).toHaveLength(2);
    expect(tour.stops[0]?.finding?.severity).toBe("high");
  });

  it("rejects unknown anchors and uncovered files", () => {
    const input = buildTourGenerationInput(metadata, evidence);
    const unknown = validTour(input.fileAnchorIds);
    unknown.stops[0]!.claims[0]!.anchorIds = ["line_invented"];
    expect(() => validateGeneratedTour(unknown, input)).toThrow(/unknown evidence anchor/);

    const uncovered = validTour(input.fileAnchorIds);
    uncovered.stops.pop();
    expect(() => validateGeneratedTour(uncovered, input)).toThrow(/does not cover changed file/);
  });

  it("rejects duplicate IDs and conspicuously verbose copy", () => {
    const input = buildTourGenerationInput(metadata, evidence);
    const duplicate = validTour(input.fileAnchorIds);
    duplicate.stops[1]!.id = duplicate.stops[0]!.id;
    expect(() => validateGeneratedTour(duplicate, input)).toThrow(/duplicated/);

    const verbose = validTour(input.fileAnchorIds);
    verbose.stops[0]!.title = "x".repeat(141);
    expect(() => validateGeneratedTour(verbose, input)).toThrow(/exceeds 140/);
  });
});

function validTour(fileAnchors: string[]) {
  return {
    summary: "The counter update moves into Redis and gains direct coverage.",
    stops: [
      {
        id: "atomic-counter", title: "Counter updates move into Redis", summary: "The write is now atomic.", purpose: "Verify concurrent behavior.",
        anchorIds: [fileAnchors[0]!, "line_new-counter"],
        claims: [{ text: "The new path calls Redis INCR.", kind: "fact", confidence: "high", anchorIds: ["line_new-counter"] }],
        prompts: ["Does the production client preserve this atomicity?"],
        finding: { title: "TTL behavior is unclear", body: "The shown change does not preserve expiry.", severity: "high", category: "Correctness", anchorIds: ["line_new-counter"], suggestedComment: "How is the counter expiry preserved after this change?" },
      },
      {
        id: "counter-test", title: "A direct counter test is added", summary: "The test covers one increment.", purpose: "Check regression coverage.",
        anchorIds: [fileAnchors[1]!, "line_test-counter"],
        claims: [{ text: "The test asserts the first increment.", kind: "fact", confidence: "high", anchorIds: ["line_test-counter"] }],
        prompts: [],
      },
    ],
  };
}
