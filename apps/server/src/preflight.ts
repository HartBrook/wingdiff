import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { PullRequestTarget } from "./targets.js";
import { repositoryIdentityFromRemoteUrl, targetRepositoryPath } from "./targets.js";

const execFile = promisify(execFileCallback);

export const MINIMUM_GITLAB_CLI_VERSION = "1.100.0";

export type CheckoutStatus = "matched" | "managed" | "different" | "not-found";

export interface LocalTargetPreflight {
  checkout: {
    status: CheckoutStatus;
    path?: string;
    repository?: string;
  };
  hostingCli: {
    provider: "github" | "gitlab";
    command: "gh" | "glab";
    installed: boolean;
    supported: boolean;
    version?: string;
    authenticated: boolean;
  };
  networkChecked: false;
}

export type CommandRunner = (command: string, arguments_: string[], cwd: string) => Promise<string>;

export async function inspectLocalTarget(
  target: PullRequestTarget,
  cwd: string,
  runCommand: CommandRunner = defaultCommandRunner,
): Promise<LocalTargetPreflight> {
  const command = target.platform === "gitlab" ? "glab" : "gh";
  const authArguments = ["auth", "status", "--hostname", target.host];
  const [checkout, cliVersionOutput, cliAuthenticated] = await Promise.all([
    inspectCheckout(target, cwd, runCommand),
    commandOutput(command, ["--version"], cwd, runCommand),
    commandExists(command, authArguments, cwd, runCommand),
  ]);
  const cliInstalled = cliVersionOutput !== undefined;
  const version = target.platform === "gitlab" && cliVersionOutput
    ? parseGitLabCliVersion(cliVersionOutput)
    : undefined;
  const supported = target.platform === "github"
    || Boolean(version && versionAtLeast(version, MINIMUM_GITLAB_CLI_VERSION));
  return {
    checkout,
    hostingCli: {
      provider: target.platform,
      command,
      installed: cliInstalled,
      supported,
      ...(version ? { version } : {}),
      authenticated: cliAuthenticated,
    },
    networkChecked: false,
  };
}

export function parseGitLabCliVersion(output: string): string | undefined {
  return /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/m.exec(output)?.[1];
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const difference = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

async function inspectCheckout(
  target: PullRequestTarget,
  cwd: string,
  runCommand: CommandRunner,
): Promise<LocalTargetPreflight["checkout"]> {
  try {
    const [repositoryPath, remote] = await Promise.all([
      resolveRepositoryPath(cwd, runCommand),
      runCommand("git", ["config", "--get", "remote.origin.url"], cwd),
    ]);
    const identity = repositoryIdentityFromRemoteUrl(remote);
    const repository = identity?.path;
    const expected = targetRepositoryPath(target).toLowerCase();
    return {
      status: identity?.platform === target.platform
        && identity.host.toLowerCase() === target.host.toLowerCase()
        && repository?.toLowerCase() === expected ? "matched" : "different",
      path: repositoryPath,
      ...(repository ? { repository } : {}),
    };
  } catch {
    return { status: "not-found" };
  }
}

async function resolveRepositoryPath(cwd: string, runCommand: CommandRunner): Promise<string> {
  try {
    return (await runCommand("git", ["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    return (await runCommand("git", ["rev-parse", "--absolute-git-dir"], cwd)).trim();
  }
}

async function commandExists(
  command: string,
  arguments_: string[],
  cwd: string,
  runCommand: CommandRunner,
): Promise<boolean> {
  try {
    await runCommand(command, arguments_, cwd);
    return true;
  } catch {
    return false;
  }
}

async function commandOutput(
  command: string,
  arguments_: string[],
  cwd: string,
  runCommand: CommandRunner,
): Promise<string | undefined> {
  try {
    return await runCommand(command, arguments_, cwd);
  } catch {
    return undefined;
  }
}

async function defaultCommandRunner(command: string, arguments_: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile(command, arguments_, { cwd });
  return stdout;
}
