import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { acquirePinnedRevisions, type GitCommandRunner } from "./git.js";
import type { PullRequestMetadata } from "./github.js";
import { parsePullRequestTarget } from "./targets.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("pinned Git revisions", () => {
  it("pins existing objects without changing the worktree or index", async () => {
    const repository = await createRepository();
    const before = await git(repository.path, ["status", "--porcelain=v1"]);
    const pinned = await acquirePinnedRevisions(repository.target, repository.metadata, repository.path);
    const after = await git(repository.path, ["status", "--porcelain=v1"]);

    expect(after).toBe(before);
    expect(await realpath(pinned.repositoryRoot)).toBe(await realpath(repository.path));
    expect({ base: pinned.base, head: pinned.head }).toEqual({
      base: { sha: repository.baseSha, ref: `refs/wingdiff/pull/42/revisions/${repository.baseSha}` },
      head: { sha: repository.headSha, ref: `refs/wingdiff/pull/42/revisions/${repository.headSha}` },
    });
    expect((await git(repository.path, ["rev-parse", pinned.base.ref])).trim()).toBe(repository.baseSha);
    expect((await git(repository.path, ["rev-parse", pinned.head.ref])).trim()).toBe(repository.headSha);
    expect(pinned.comparisonBase).toEqual({
      sha: repository.baseSha,
      ref: `refs/wingdiff/pull/42/revisions/${repository.baseSha}`,
    });
  });

  it("pins the merge base when the target branch has advanced independently", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wingdiff-git-test-"));
    temporaryDirectories.push(directory);
    await git(directory, ["init", "--quiet"]);
    await git(directory, ["config", "user.email", "wingdiff@example.com"]);
    await git(directory, ["config", "user.name", "Wingdiff Test"]);
    await writeFile(path.join(directory, "shared.ts"), "export const shared = 1;\n");
    await git(directory, ["add", "shared.ts"]);
    await git(directory, ["commit", "--quiet", "-m", "common"]);
    const mergeBaseSha = (await git(directory, ["rev-parse", "HEAD"])).trim();
    await git(directory, ["branch", "feature"]);
    await writeFile(path.join(directory, "base-only.ts"), "export const baseOnly = true;\n");
    await git(directory, ["add", "base-only.ts"]);
    await git(directory, ["commit", "--quiet", "-m", "base advances"]);
    const baseSha = (await git(directory, ["rev-parse", "HEAD"])).trim();
    await git(directory, ["checkout", "--quiet", "feature"]);
    await writeFile(path.join(directory, "feature-only.ts"), "export const featureOnly = true;\n");
    await git(directory, ["add", "feature-only.ts"]);
    await git(directory, ["commit", "--quiet", "-m", "feature changes"]);
    const headSha = (await git(directory, ["rev-parse", "HEAD"])).trim();
    const target = parsePullRequestTarget("https://github.com/openai/codex/pull/42");

    const pinned = await acquirePinnedRevisions(target, metadataFor(target.canonicalUrl, baseSha, headSha), directory);

    expect(pinned.comparisonBase?.sha).toBe(mergeBaseSha);
    expect((await git(directory, ["rev-parse", pinned.comparisonBase!.ref])).trim()).toBe(mergeBaseSha);
  });

  it("fetches missing objects into private refs", async () => {
    const target = parsePullRequestTarget("https://github.com/openai/codex/pull/42");
    const metadata = metadataFor(target.canonicalUrl, "a".repeat(40), "b".repeat(40));
    const calls: string[][] = [];
    let baseExists = false;
    let headExists = false;
    const runner: GitCommandRunner = async (arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === "rev-parse" && arguments_[1] === "--show-toplevel") return "/work/codex\n";
      if (arguments_[0] === "cat-file") {
        const exists = arguments_[2]?.startsWith("a") ? baseExists : headExists;
        if (!exists) throw new Error("missing");
        return "";
      }
      if (arguments_[0] === "fetch" && arguments_.at(-1)?.includes("refs/heads")) { baseExists = true; return ""; }
      if (arguments_[0] === "fetch" && arguments_.at(-1)?.includes("refs/pull")) { headExists = true; return ""; }
      if (arguments_[0] === "merge-base") return `${metadata.base.sha}\n`;
      if (arguments_[0] === "rev-parse") return `${metadata.head.sha}\n`;
      return "";
    };

    await acquirePinnedRevisions(target, metadata, "/work/codex", runner);
    expect(calls).toContainEqual(["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/main:refs/wingdiff/pull/42/revisions/${metadata.base.sha}`]);
    expect(calls).toContainEqual(["fetch", "--no-tags", "--quiet", "origin", `+refs/pull/42/head:refs/wingdiff/pull/42/revisions/${metadata.head.sha}`]);
  });

  it("rejects a head that moves between metadata and fetch", async () => {
    const target = parsePullRequestTarget("https://github.com/openai/codex/pull/42");
    const metadata = metadataFor(target.canonicalUrl, "a".repeat(40), "b".repeat(40));
    const runner: GitCommandRunner = async (arguments_) => {
      if (arguments_[0] === "rev-parse" && arguments_[1] === "--show-toplevel") return "/work/codex";
      if (arguments_[0] === "cat-file" && arguments_[2]?.startsWith("a")) return "";
      if (arguments_[0] === "cat-file") throw new Error("missing");
      if (arguments_[0] === "rev-parse") return `${"c".repeat(40)}\n`;
      return "";
    };

    await expect(acquirePinnedRevisions(target, metadata, "/work/codex", runner)).rejects.toThrow(/moved during acquisition/);
  });
});

async function createRepository() {
  const directory = await mkdtemp(path.join(tmpdir(), "wingdiff-git-test-"));
  temporaryDirectories.push(directory);
  await git(directory, ["init", "--quiet"]);
  await git(directory, ["config", "user.email", "wingdiff@example.com"]);
  await git(directory, ["config", "user.name", "Wingdiff Test"]);
  await writeFile(path.join(directory, "counter.ts"), "export const counter = 1;\n");
  await git(directory, ["add", "counter.ts"]);
  await git(directory, ["commit", "--quiet", "-m", "base"]);
  const baseSha = (await git(directory, ["rev-parse", "HEAD"])).trim();
  await writeFile(path.join(directory, "counter.ts"), "export const counter = 2;\n");
  await git(directory, ["commit", "--quiet", "-am", "head"]);
  const headSha = (await git(directory, ["rev-parse", "HEAD"])).trim();
  const target = parsePullRequestTarget("https://github.com/openai/codex/pull/42");
  return { path: directory, baseSha, headSha, target, metadata: metadataFor(target.canonicalUrl, baseSha, headSha) };
}

function metadataFor(url: string, baseSha: string, headSha: string): PullRequestMetadata {
  return {
    number: 42,
    repository: "openai/codex",
    url,
    title: "Test PR",
    body: "",
    author: { login: "octocat" },
    base: { ref: "main", sha: baseSha },
    head: { ref: "feature", sha: headSha },
    additions: 1,
    deletions: 1,
    filesChanged: 1,
    commits: [],
    checks: { passed: 0, failed: 0, pending: 0, total: 0 },
    reviews: { count: 0 },
    state: "OPEN",
    draft: false,
    updatedAt: "2026-09-29T12:00:00Z",
  };
}

async function git(cwd: string, arguments_: string[]): Promise<string> {
  const { stdout } = await execFile("git", arguments_, { cwd });
  return stdout;
}
