import { describe, expect, it } from "vitest";
import { normalizePullRequestMetadata, readPullRequestMetadata, type GitHubCommandRunner } from "./github.js";
import { parsePullRequestTarget } from "./targets.js";

const target = parsePullRequestTarget("https://github.com/openai/codex/pull/42");
const raw = {
  additions: 31,
  author: { login: "octocat", name: "Octo Cat" },
  baseRefName: "main",
  baseRefOid: "a".repeat(40),
  body: "Make the counter atomic.",
  changedFiles: 2,
  commits: [{ oid: "c".repeat(40), messageHeadline: "Fix counter", authoredDate: "2026-09-29T12:00:00Z" }],
  deletions: 8,
  headRefName: "fix/counter",
  headRefOid: "b".repeat(40),
  isDraft: false,
  latestReviews: [{ state: "APPROVED" }],
  number: 42,
  reviewDecision: "APPROVED",
  state: "OPEN",
  statusCheckRollup: [
    { __typename: "CheckRun", conclusion: "SUCCESS" },
    { __typename: "CheckRun", conclusion: "FAILURE" },
    { __typename: "StatusContext", state: "PENDING" },
  ],
  title: "Make retries atomic",
  updatedAt: "2026-09-29T12:30:00Z",
  url: target.canonicalUrl,
};

describe("GitHub pull request metadata", () => {
  it("requests a bounded JSON projection and normalizes it", async () => {
    const calls: string[][] = [];
    const runner: GitHubCommandRunner = async (arguments_) => {
      calls.push(arguments_);
      return JSON.stringify(raw);
    };
    const metadata = await readPullRequestMetadata(target, "/work/codex", runner);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 4)).toEqual(["pr", "view", target.canonicalUrl, "--json"]);
    expect(metadata).toMatchObject({
      number: 42,
      repository: "openai/codex",
      base: { ref: "main", sha: "a".repeat(40) },
      head: { ref: "fix/counter", sha: "b".repeat(40) },
      checks: { passed: 1, failed: 1, pending: 1, total: 3 },
      reviews: { count: 1, decision: "APPROVED" },
    });
  });

  it("rejects metadata for a different pull request", () => {
    expect(() => normalizePullRequestMetadata({ ...raw, url: "https://github.com/openai/codex/pull/43" }, target)).toThrow(/requested openai\/codex#42/);
  });

  it("rejects missing pinned revisions and malformed output", async () => {
    expect(() => normalizePullRequestMetadata({ ...raw, headRefOid: "short" }, target)).toThrow(/head sha/);
    await expect(readPullRequestMetadata(target, "/work", async () => "not json")).rejects.toThrow(/invalid pull request metadata/);
  });
});
