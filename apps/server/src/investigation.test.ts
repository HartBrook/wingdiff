import { describe, expect, it } from "vitest";
import { buildSessionInvestigationContext, type InvestigationGitRunner } from "./investigation.js";
import type { PullRequestEvidence } from "./diff.js";
import type { PullRequestMetadata } from "./github.js";
import { SessionStore } from "./sessions.js";
import { parsePullRequestTarget } from "./targets.js";

describe("session-grounded investigation", () => {
  it("reconstructs the stop and adds pinned source and symbol references", async () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence);
    store.saveTour(session.id, "full", { provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" }, evidence.baseSha, evidence.headSha, {
      summary: "The counter becomes atomic.",
      findingRevisions: [],
      stops: [{
        id: "atomic-counter",
        title: "Counter update",
        summary: "Redis performs the increment.",
        purpose: "Verify concurrent behavior.",
        anchorIds: ["line_new-counter"],
        claims: [{ text: "The new path calls incrementCounter.", kind: "fact", confidence: "high", anchorIds: ["line_new-counter"] }],
        prompts: [],
      }],
    });
    const calls: string[][] = [];
    const runGit: InvestigationGitRunner = async (arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === "show" && String(arguments_[1]).startsWith(evidence.headSha)) {
        return "export async function update(key: string) {\n  return incrementCounter(key);\n}\n";
      }
      if (arguments_[0] === "show") return "export function update(value: number) {\n  return value + 1;\n}\n";
      if (arguments_[0] === "grep") return `${evidence.headSha}:src/caller.ts:7:await incrementCounter(key);\n`;
      throw new Error("unexpected Git command");
    };

    const context = await buildSessionInvestigationContext(
      session,
      store,
      "full",
      "atomic-counter",
      "Who calls this?",
      "/work/repo",
      runGit,
    );

    expect(context.stop.title).toBe("Counter update");
    expect(context.stop.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/counter.ts", revision: "diff" }),
      expect.objectContaining({ path: "src/counter.ts", revision: "head" }),
      expect.objectContaining({ path: "src/counter.ts", revision: "base" }),
      expect.objectContaining({ path: "src/caller.ts", revision: "related" }),
    ]));
    expect(calls.some((arguments_) => arguments_[0] === "grep" && arguments_.includes("incrementCounter"))).toBe(true);
    store.close();
  });

  it("rejects stops that are not in the persisted current tour", async () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence);
    await expect(buildSessionInvestigationContext(session, store, "full", "invented", "Question?", "/work/repo"))
      .rejects.toThrow(/Generate this guided review/);
    store.close();
  });
});

const target = parsePullRequestTarget("https://github.com/openai/codex/pull/42");
const metadata = {
  number: 42, repository: "openai/codex", url: target.canonicalUrl, title: "Atomic counter", body: "",
  author: { login: "octocat" }, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature", sha: "b".repeat(40) },
  additions: 1, deletions: 1, filesChanged: 1, commits: [], checks: { passed: 1, failed: 0, pending: 0, total: 1 },
  reviews: { count: 0 }, state: "OPEN", draft: false, updatedAt: "2026-09-29T12:00:00Z",
} satisfies PullRequestMetadata;
const evidence = {
  baseSha: metadata.base.sha,
  headSha: metadata.head.sha,
  additions: 1,
  deletions: 1,
  files: [{
    oldPath: "src/counter.ts", path: "src/counter.ts", status: "modified", additions: 1, deletions: 1,
    hunks: [{
      header: "@@ -2 +2 @@", oldStart: 2, oldLines: 1, newStart: 2, newLines: 1,
      lines: [
        { kind: "deletion", content: "return value + 1;", oldLine: 2, fingerprint: "old-counter" },
        { kind: "addition", content: "return incrementCounter(key);", newLine: 2, fingerprint: "new-counter" },
      ],
    }],
  }],
} satisfies PullRequestEvidence;
