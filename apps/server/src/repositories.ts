import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { inspectLocalTarget, type LocalTargetPreflight } from "./preflight.js";
import { defaultDatabasePath } from "./sessions.js";
import type { PullRequestTarget } from "./targets.js";

const execFile = promisify(execFileCallback);

export type RepositoryCommandRunner = (command: string, arguments_: string[], cwd: string) => Promise<string>;

export interface RepositoryResolutionDependencies {
  inspectTarget: (target: PullRequestTarget, cwd: string) => Promise<LocalTargetPreflight>;
  runCommand: RepositoryCommandRunner;
}

const defaultDependencies: RepositoryResolutionDependencies = {
  inspectTarget: inspectLocalTarget,
  runCommand: async (command, arguments_, cwd) => {
    const { stdout } = await execFile(command, arguments_, { cwd, maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  },
};

export function managedRepositoryPath(
  target: PullRequestTarget,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    path.dirname(defaultDatabasePath(environment)),
    "repositories",
    target.owner.toLowerCase(),
    `${target.repository.toLowerCase()}.git`,
  );
}

export async function prepareRepositoryTarget(
  target: PullRequestTarget,
  launchDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: RepositoryResolutionDependencies = defaultDependencies,
): Promise<LocalTargetPreflight> {
  const local = await dependencies.inspectTarget(target, launchDirectory);
  if (local.checkout.status === "matched") return local;
  const cachePath = managedRepositoryPath(target, environment);
  const cached = await pathExists(cachePath);
  return {
    ...local,
    checkout: {
      status: "managed",
      repository: `${target.owner}/${target.repository}`,
      ...(cached ? { path: cachePath } : {}),
    },
  };
}

export async function resolveRepositoryTarget(
  target: PullRequestTarget,
  launchDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: RepositoryResolutionDependencies = defaultDependencies,
): Promise<string> {
  const local = await dependencies.inspectTarget(target, launchDirectory);
  if (local.checkout.status === "matched" && local.checkout.path) return local.checkout.path;
  if (!local.githubCli.installed) throw new Error("GitHub CLI is not installed. Install gh, then run: gh auth login");
  if (!local.githubCli.authenticated) throw new Error("GitHub CLI is not authenticated for github.com. Run: gh auth login");

  const cachePath = managedRepositoryPath(target, environment);
  if (await pathExists(cachePath)) return cachePath;

  const parent = path.dirname(cachePath);
  const temporaryPath = `${cachePath}.tmp-${randomUUID()}`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  try {
    await dependencies.runCommand("gh", [
      "repo",
      "clone",
      `${target.owner}/${target.repository}`,
      temporaryPath,
      "--",
      "--bare",
      "--filter=blob:none",
    ], parent);
    try {
      await rename(temporaryPath, cachePath);
    } catch (error) {
      if (!await pathExists(cachePath)) throw error;
    }
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
  return cachePath;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}
