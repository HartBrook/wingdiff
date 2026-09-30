import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { PullRequestTarget } from "./targets.js";
import { repositoryFromRemoteUrl } from "./targets.js";

const execFile = promisify(execFileCallback);

export type CheckoutStatus = "matched" | "managed" | "different" | "not-found";

export interface LocalTargetPreflight {
  checkout: {
    status: CheckoutStatus;
    path?: string;
    repository?: string;
  };
  githubCli: {
    installed: boolean;
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
  const [checkout, githubCli, githubAuth] = await Promise.all([
    inspectCheckout(target, cwd, runCommand),
    commandExists("gh", ["--version"], cwd, runCommand),
    commandExists("gh", ["auth", "status", "--hostname", "github.com"], cwd, runCommand),
  ]);
  return { checkout, githubCli: { installed: githubCli, authenticated: githubAuth }, networkChecked: false };
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
    const repository = repositoryFromRemoteUrl(remote);
    const expected = `${target.owner}/${target.repository}`.toLowerCase();
    return {
      status: repository?.toLowerCase() === expected ? "matched" : "different",
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

async function defaultCommandRunner(command: string, arguments_: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile(command, arguments_, { cwd });
  return stdout;
}
