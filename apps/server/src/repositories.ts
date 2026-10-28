import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { inspectLocalTarget, MINIMUM_GITLAB_CLI_VERSION, type LocalTargetPreflight } from "./preflight.js";
import { defaultDatabasePath } from "./sessions.js";
import { codeHostName, targetRepositoryPath, type PullRequestTarget } from "./targets.js";

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
  const root = path.join(path.dirname(defaultDatabasePath(environment)), "repositories");
  if (target.platform === "github" && target.host === "github.com") {
    return path.join(root, target.owner.toLowerCase(), `${target.repository.toLowerCase()}.git`);
  }
  return path.join(
    root,
    "gitlab",
    target.host.toLowerCase().replace(/[^a-z0-9.-]/g, "_"),
    ...target.owner.toLowerCase().split("/"),
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
      repository: targetRepositoryPath(target),
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
  const hostName = codeHostName(target);
  if (!local.hostingCli.installed) {
    throw new Error(`${hostName} CLI is not installed. Install ${local.hostingCli.command}, then run: ${local.hostingCli.command} auth login`);
  }
  if (!local.hostingCli.supported) {
    const found = local.hostingCli.version ? ` Found ${local.hostingCli.version}.` : "";
    throw new Error(`GitLab CLI ${MINIMUM_GITLAB_CLI_VERSION} or later is required.${found} Upgrade glab and try again.`);
  }
  if (!local.hostingCli.authenticated) {
    throw new Error(`${hostName} CLI is not authenticated for ${target.host}. Run: ${local.hostingCli.command} auth login${target.host === "github.com" || target.host === "gitlab.com" ? "" : ` --hostname ${target.host}`}`);
  }

  const cachePath = managedRepositoryPath(target, environment);
  if (await pathExists(cachePath)) return cachePath;

  const parent = path.dirname(cachePath);
  const temporaryPath = `${cachePath}.tmp-${randomUUID()}`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  try {
    const command = target.platform === "gitlab" ? "glab" : "gh";
    const repository = target.platform === "gitlab"
      ? `https://${target.host}/${targetRepositoryPath(target)}`
      : targetRepositoryPath(target);
    await dependencies.runCommand(command, [
      "repo",
      "clone",
      repository,
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
