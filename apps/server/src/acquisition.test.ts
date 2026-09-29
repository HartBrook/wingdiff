import { describe, expect, it, vi } from "vitest";
import { acquireReviewSession, refreshReviewSession, type AcquisitionDependencies, type AcquisitionStage } from "./acquisition.js";
import type { PullRequestEvidence } from "./diff.js";
import type { PinnedRevisions } from "./git.js";
import type { PullRequestMetadata } from "./github.js";
import type { LocalTargetPreflight } from "./preflight.js";
import { SessionStore } from "./sessions.js";
import { parsePullRequestTarget } from "./targets.js";

const target = parsePullRequestTarget("https://github.com/openai/codex/pull/42");
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

describe("review acquisition", () => {
  it("runs the read-only pipeline in order and persists its result", async () => {
    const store = new SessionStore(":memory:");
    const stages: AcquisitionStage[] = [];
    const dependencies = fixtureDependencies();
    const session = await acquireReviewSession(target, "/work/codex", store, (stage) => stages.push(stage), dependencies);

    expect(stages).toEqual(["preflight", "metadata", "revisions", "evidence", "persisting"]);
    expect(session.metadata.head.sha).toBe(headSha);
    expect(session.evidence.files).toHaveLength(1);
    expect(store.getSession(session.id)).toEqual(session);
    store.close();
  });

  it("stops before GitHub access when the checkout does not match", async () => {
    const store = new SessionStore(":memory:");
    const dependencies = fixtureDependencies();
    dependencies.inspectTarget = async () => ({
      checkout: { status: "different", path: "/work/other", repository: "other/repo" },
      githubCli: { installed: true },
      networkChecked: false,
    });
    const readMetadata = vi.spyOn(dependencies, "readMetadata");

    await expect(acquireReviewSession(target, "/work/other", store, undefined, dependencies)).rejects.toThrow(/Launch Wingdiff from a checkout/);
    expect(readMetadata).not.toHaveBeenCalled();
    store.close();
  });

  it("rejects evidence produced from any other revision pair", async () => {
    const store = new SessionStore(":memory:");
    const dependencies = fixtureDependencies();
    dependencies.readEvidence = async () => ({ ...evidence(), headSha: "c".repeat(40) });
    await expect(acquireReviewSession(target, "/work/codex", store, undefined, dependencies)).rejects.toThrow(/does not match/);
    store.close();
  });

  it("compares a new head against the latest explicit review checkpoint", async () => {
    const store = new SessionStore(":memory:");
    const baseline = await acquireReviewSession(target, "/work/codex", store, undefined, fixtureDependencies());
    store.saveCheckpoint(baseline.id, {
      reviewedHeadSha: baseline.metadata.head.sha,
      completedAt: "2026-09-29T12:10:00Z",
      coverage: { counter: "understood" },
      findingRevisions: [],
    });
    const nextHead = "c".repeat(40);
    const stages: AcquisitionStage[] = [];
    const dependencies = fixtureDependencies();
    dependencies.readMetadata = async () => ({ ...metadata(), head: { ref: "feature", sha: nextHead } });
    dependencies.acquireRevisions = async () => ({
      repositoryRoot: "/work/codex",
      base: { ref: "base", sha: baseSha },
      head: { ref: "head", sha: nextHead },
    });
    dependencies.readEvidence = async (input) => ({
      baseSha: input.base.sha,
      headSha: input.head.sha,
      additions: 1,
      deletions: 0,
      files: [{ path: "counter.ts", oldPath: "counter.ts", status: "modified", additions: 1, deletions: 0, hunks: [] }],
    });

    const result = await refreshReviewSession(target, "/work/codex", store, (stage) => stages.push(stage), dependencies);

    expect(stages).toEqual(["preflight", "metadata", "revisions", "evidence", "persisting", "update-evidence"]);
    expect(result.status).toBe("updated");
    expect(result.update).toMatchObject({ fromHeadSha: headSha, toHeadSha: nextHead });
    expect(result.session.evidence.baseSha).toBe(baseSha);
    expect(result.update?.evidence.baseSha).toBe(headSha);
    store.close();
  });

  it("reports a current head without creating update evidence", async () => {
    const store = new SessionStore(":memory:");
    const baseline = await acquireReviewSession(target, "/work/codex", store, undefined, fixtureDependencies());
    store.saveCheckpoint(baseline.id, {
      reviewedHeadSha: baseline.metadata.head.sha,
      completedAt: "2026-09-29T12:10:00Z",
      coverage: { counter: "understood" },
      findingRevisions: [],
    });

    const result = await refreshReviewSession(target, "/work/codex", store, undefined, fixtureDependencies());

    expect(result.status).toBe("current");
    expect(result.update).toBeUndefined();
    store.close();
  });
});

function fixtureDependencies(): AcquisitionDependencies {
  return {
    inspectTarget: async () => preflight(),
    readMetadata: async () => metadata(),
    acquireRevisions: async () => revisions(),
    readEvidence: async () => evidence(),
  };
}

function preflight(): LocalTargetPreflight {
  return {
    checkout: { status: "matched", path: "/work/codex", repository: "openai/codex" },
    githubCli: { installed: true },
    networkChecked: false,
  };
}

function metadata(): PullRequestMetadata {
  return {
    number: 42, repository: "openai/codex", url: target.canonicalUrl, title: "Atomic counter", body: "",
    author: { login: "octocat" }, base: { ref: "main", sha: baseSha }, head: { ref: "feature", sha: headSha },
    additions: 1, deletions: 0, filesChanged: 1, commits: [],
    checks: { passed: 1, failed: 0, pending: 0, total: 1 }, reviews: { count: 0 },
    state: "OPEN", draft: false, updatedAt: "2026-09-29T12:00:00Z",
  };
}

function revisions(): PinnedRevisions {
  return {
    repositoryRoot: "/work/codex",
    base: { ref: "refs/wingdiff/pull/42/base", sha: baseSha },
    head: { ref: "refs/wingdiff/pull/42/head", sha: headSha },
  };
}

function evidence(): PullRequestEvidence {
  return {
    baseSha, headSha, additions: 1, deletions: 0,
    files: [{ path: "counter.ts", oldPath: "counter.ts", status: "modified", additions: 1, deletions: 0, hunks: [] }],
  };
}
