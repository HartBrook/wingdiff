#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadWingdiffEnvironment } from "./environment.js";
import { repositoryRoot } from "./environment.js";
import { startWingdiffServer } from "./server.js";
import { defaultDatabasePath } from "./sessions.js";
import { parsePullRequestTarget, repositoryFromRemoteUrl, type PullRequestTarget } from "./targets.js";

const execFile = promisify(execFileCallback);

export interface CliOptions {
  command: "open" | "doctor" | "stop";
  target?: string;
  checkout?: string;
  demo: boolean;
  openBrowser: boolean;
  help: boolean;
  version: boolean;
}

export function parseCliArguments(arguments_: string[]): CliOptions {
  let target: string | undefined;
  let checkout: string | undefined;
  let demo = false;
  let openBrowser = true;
  let help = false;
  let version = false;
  let command: CliOptions["command"] = "open";

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "demo" || argument === "--demo") demo = true;
    else if (argument === "doctor" || argument === "stop") {
      if (command !== "open" || target || demo) throw new Error("Wingdiff accepts one command at a time.");
      command = argument;
    }
    else if (argument === "--no-open") openBrowser = false;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--version" || argument === "-v") version = true;
    else if (argument === "--checkout") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--checkout requires a path.");
      if (checkout) throw new Error("Wingdiff accepts one checkout path at a time.");
      checkout = value;
      index += 1;
    } else if (argument.startsWith("--checkout=")) {
      const value = argument.slice("--checkout=".length);
      if (!value) throw new Error("--checkout requires a path.");
      if (checkout) throw new Error("Wingdiff accepts one checkout path at a time.");
      checkout = value;
    }
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (target) throw new Error("Wingdiff accepts one pull request target at a time.");
    else target = argument;
  }

  if (demo && target) throw new Error("Use either demo or a pull request target, not both.");
  if (command !== "open" && (target || checkout || demo || !openBrowser)) {
    throw new Error(`${command} does not accept pull request or launcher options.`);
  }
  return { command, target, ...(checkout ? { checkout } : {}), demo, openBrowser, help, version };
}

export function resolveWorkingDirectory(
  checkout: string | undefined,
  initialDirectory: string | undefined,
  currentDirectory = process.cwd(),
): string {
  const launchDirectory = initialDirectory ?? currentDirectory;
  return checkout ? path.resolve(launchDirectory, checkout) : path.resolve(launchDirectory);
}

export function launchUrl(baseUrl: string, options: { demo: boolean; target?: PullRequestTarget; authToken?: string }): string {
  const url = new URL(baseUrl);
  if (options.demo) url.searchParams.set("demo", "1");
  if (options.target) url.searchParams.set("target", options.target.canonicalUrl);
  if (options.authToken) url.searchParams.set("wingdiff_token", options.authToken);
  return url.toString();
}

export function browserInvocation(platform: NodeJS.Platform, url: string): { command: string; arguments: string[] } {
  if (platform === "darwin") return { command: "open", arguments: [url] };
  if (platform === "win32") return { command: "cmd", arguments: ["/c", "start", "", url] };
  return { command: "xdg-open", arguments: [url] };
}

export async function repositoryForCheckout(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("git", ["config", "--get", "remote.origin.url"], { cwd });
    return repositoryFromRemoteUrl(stdout);
  } catch {
    return undefined;
  }
}

export type CliCommandRunner = (command: string, arguments_: string[], cwd: string) => Promise<string>;

export async function inferPullRequestTarget(
  cwd: string,
  runCommand: CliCommandRunner = runCliCommand,
): Promise<string | undefined> {
  try {
    const repository = (await runCommand("git", ["config", "--get", "remote.origin.url"], cwd)).trim();
    if (!repositoryFromRemoteUrl(repository)) return undefined;
    const url = (await runCommand("gh", ["pr", "view", "--json", "url", "--jq", ".url"], cwd)).trim();
    return url || undefined;
  } catch {
    return undefined;
  }
}

export interface DoctorCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export async function diagnoseEnvironment(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  runCommand: CliCommandRunner = runCliCommand,
): Promise<DoctorCheck[]> {
  const available = async (command: string, arguments_: string[]) => {
    try {
      await runCommand(command, arguments_, cwd);
      return true;
    } catch {
      return false;
    }
  };
  const [git, githubCli, githubAuth, codex] = await Promise.all([
    available("git", ["--version"]),
    available("gh", ["--version"]),
    available("gh", ["auth", "status", "--hostname", "github.com"]),
    available(environment.WINGDIFF_CODEX_BIN || "codex", ["login", "status"]),
  ]);
  const directProvider = Boolean(environment.OPENAI_API_KEY || environment.ANTHROPIC_API_KEY);
  return [
    { label: "Git", ok: git, detail: git ? "installed" : "not found; install Git" },
    { label: "GitHub CLI", ok: githubCli, detail: githubCli ? "installed" : "not found; install gh" },
    {
      label: "GitHub authentication",
      ok: githubAuth,
      detail: githubAuth ? "authenticated" : "not authenticated; run: gh auth login",
    },
    {
      label: "AI provider",
      ok: codex || directProvider,
      detail: codex
        ? "Codex CLI authenticated"
        : directProvider
          ? "direct API key configured"
          : "not configured; run: codex login",
    },
  ];
}

async function run() {
  loadWingdiffEnvironment();
  const options = parseCliArguments(process.argv.slice(2));
  if (options.version) {
    process.stdout.write(`${await packageVersion()}\n`);
    return;
  }
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  const workingDirectory = resolveWorkingDirectory(options.checkout, process.env.INIT_CWD);
  if (options.command === "doctor") {
    const checks = await diagnoseEnvironment(workingDirectory);
    for (const check of checks) process.stdout.write(`${check.ok ? "✓" : "✗"} ${check.label}: ${check.detail}\n`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }

  const discoveryPath = serverDiscoveryPath(process.env);
  if (options.command === "stop") {
    await stopWingdiff(discoveryPath);
    return;
  }

  const targetInput = options.target ?? (!options.demo ? await inferPullRequestTarget(workingDirectory) : undefined);
  const checkoutRepository = targetInput && /^#?\d+$/.test(targetInput)
    ? await repositoryForCheckout(workingDirectory)
    : undefined;
  const target = targetInput ? parsePullRequestTarget(targetInput, checkoutRepository) : undefined;
  const existing = await readServerDiscovery(discoveryPath);
  if (existing && await isWingdiffRunning(existing.url, existing.authToken)) {
    const destination = launchUrl(existing.url, { demo: options.demo, target, authToken: existing.authToken });
    process.stdout.write(`Reusing Wingdiff at ${destination}\n`);
    if (options.openBrowser) openBrowser(destination);
    return;
  }

  const running = await startWingdiffServer({ cwd: workingDirectory });
  await writeServerDiscovery(discoveryPath, {
    url: running.url,
    authToken: running.authToken,
    cwd: workingDirectory,
    pid: process.pid,
  });
  running.server.once("close", () => void removeServerDiscovery(discoveryPath, running.authToken));
  const runningDestination = launchUrl(running.url, { demo: options.demo, target, authToken: running.authToken });
  process.stdout.write(`Wingdiff is ready at ${runningDestination}\n`);
  process.stdout.write("Press Ctrl+C to stop the local server.\n");
  if (options.openBrowser) openBrowser(runningDestination);
}

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error("Wingdiff package version is unavailable.");
  return manifest.version;
}

async function stopWingdiff(discoveryPath: string) {
  const existing = await readServerDiscovery(discoveryPath);
  if (!existing || !await isWingdiffRunning(existing.url, existing.authToken)) {
    await unlink(discoveryPath).catch(() => undefined);
    process.stdout.write("Wingdiff is not running.\n");
    return;
  }
  process.kill(existing.pid, "SIGTERM");
  await unlink(discoveryPath).catch(() => undefined);
  process.stdout.write("Stopped Wingdiff.\n");
}

async function runCliCommand(command: string, arguments_: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile(command, arguments_, { cwd });
  return stdout;
}

async function isWingdiffRunning(baseUrl: string, authToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const body = await response.json() as { service?: string };
    return body.service === "wingdiff";
  } catch {
    return false;
  }
}

interface ServerDiscovery {
  url: string;
  authToken: string;
  cwd: string;
  pid: number;
}

export function serverDiscoveryPath(environment: NodeJS.ProcessEnv = process.env) {
  return path.join(path.dirname(defaultDatabasePath(environment)), "server.json");
}

async function readServerDiscovery(filePath: string): Promise<ServerDiscovery | undefined> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as Partial<ServerDiscovery>;
    const url = typeof value.url === "string" ? new URL(value.url) : undefined;
    if (!url || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) return undefined;
    if (typeof value.authToken !== "string" || value.authToken.length < 32) return undefined;
    if (typeof value.cwd !== "string" || !value.cwd || !Number.isSafeInteger(value.pid)) return undefined;
    return value as ServerDiscovery;
  } catch {
    return undefined;
  }
}

async function writeServerDiscovery(filePath: string, discovery: ServerDiscovery) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(discovery)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function removeServerDiscovery(filePath: string, authToken: string) {
  const current = await readServerDiscovery(filePath);
  if (current?.authToken !== authToken) return;
  await unlink(filePath).catch(() => undefined);
}

function openBrowser(url: string) {
  const invocation = browserInvocation(process.platform, url);
  const child = spawn(invocation.command, invocation.arguments, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    process.stderr.write(`Could not open a browser. Open ${url} manually.\n`);
  });
  child.unref();
}

function helpText(): string {
  return `wingdiff — guided pull request review\n\nUsage:\n  wingdiff [pull-request]\n  wingdiff demo\n  wingdiff doctor\n  wingdiff stop\n\nWith no target, Wingdiff opens the pull request for the current branch when one exists.\n\nTargets:\n  https://github.com/owner/repo/pull/123\n  owner/repo#123\n  123                         Resolve from the current checkout\n\nOptions:\n  --checkout <path>           Use a specific local checkout\n  --no-open                   Start without opening a browser\n  -v, --version               Show the installed version\n  -h, --help                  Show this help\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : "Wingdiff could not start.";
    process.stderr.write(`wingdiff: ${message}\n`);
    process.exitCode = 1;
  });
}
