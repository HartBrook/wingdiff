import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { PullRequestMetadata } from "./github.js";
import type { PullRequestTarget } from "./targets.js";

const execFile = promisify(execFileCallback);

export type GitCommandRunner = (arguments_: string[], cwd: string) => Promise<string>;

export interface PinnedRevisions {
  repositoryRoot: string;
  /** The current target branch tip reported by the code host. */
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
  /** The merge base used for the full change-request comparison. */
  comparisonBase?: { sha: string; ref: string };
}

export async function acquirePinnedRevisions(
  target: PullRequestTarget,
  metadata: PullRequestMetadata,
  checkoutPath: string,
  runCommand: GitCommandRunner = defaultGitCommandRunner,
): Promise<PinnedRevisions> {
  const repositoryRoot = path.resolve(checkoutPath);
  const namespace = `refs/wingdiff/${target.platform === "gitlab" ? "merge-request" : "pull"}/${target.number}`;
  const baseRef = `${namespace}/revisions/${metadata.base.sha}`;
  const headRef = `${namespace}/revisions/${metadata.head.sha}`;

  await ensureBaseRevision(metadata, baseRef, repositoryRoot, runCommand);
  await ensureHeadRevision(target, metadata, headRef, repositoryRoot, runCommand);

  await runCommand(["update-ref", baseRef, metadata.base.sha], repositoryRoot);
  await runCommand(["update-ref", headRef, metadata.head.sha], repositoryRoot);

  const comparisonBaseSha = (await runCommand([
    "merge-base",
    metadata.base.sha,
    metadata.head.sha,
  ], repositoryRoot)).trim();
  if (!/^[a-f0-9]{40}$/i.test(comparisonBaseSha)) {
    throw new Error("Git could not determine the review request merge base.");
  }
  const comparisonBaseRef = `${namespace}/revisions/${comparisonBaseSha}`;
  await runCommand(["update-ref", comparisonBaseRef, comparisonBaseSha], repositoryRoot);

  return {
    repositoryRoot,
    base: { sha: metadata.base.sha, ref: baseRef },
    head: { sha: metadata.head.sha, ref: headRef },
    comparisonBase: { sha: comparisonBaseSha, ref: comparisonBaseRef },
  };
}

async function ensureBaseRevision(
  metadata: PullRequestMetadata,
  baseRef: string,
  cwd: string,
  runCommand: GitCommandRunner,
) {
  if (await objectExists(metadata.base.sha, cwd, runCommand)) return;

  await runCommand([
    "fetch",
    "--no-tags",
    "--quiet",
    "origin",
    `+refs/heads/${metadata.base.ref}:${baseRef}`,
  ], cwd);

  if (!await objectExists(metadata.base.sha, cwd, runCommand)) {
    await runCommand(["fetch", "--no-tags", "--quiet", "origin", metadata.base.sha], cwd);
  }
  if (!await objectExists(metadata.base.sha, cwd, runCommand)) {
    throw new Error(`Git could not acquire the pinned base revision ${shortSha(metadata.base.sha)}.`);
  }
}

async function ensureHeadRevision(
  target: PullRequestTarget,
  metadata: PullRequestMetadata,
  headRef: string,
  cwd: string,
  runCommand: GitCommandRunner,
) {
  if (await objectExists(metadata.head.sha, cwd, runCommand)) return;

  const sourceRef = target.platform === "gitlab"
    ? `refs/merge-requests/${target.number}/head`
    : `refs/pull/${target.number}/head`;
  await runCommand([
    "fetch",
    "--no-tags",
    "--quiet",
    "origin",
    `+${sourceRef}:${headRef}`,
  ], cwd);
  const fetchedHead = (await runCommand(["rev-parse", headRef], cwd)).trim();
  if (fetchedHead.toLowerCase() !== metadata.head.sha.toLowerCase()) {
    throw new Error(`${target.platform === "gitlab" ? "Merge" : "Pull"} request ${target.label} moved during acquisition. Refresh and try again.`);
  }
}

async function objectExists(sha: string, cwd: string, runCommand: GitCommandRunner): Promise<boolean> {
  try {
    await runCommand(["cat-file", "-e", `${sha}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

async function defaultGitCommandRunner(arguments_: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", arguments_, { cwd, maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    throw new Error(stderr || `Git failed while running: git ${arguments_.join(" ")}`);
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
