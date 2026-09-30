#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadWingdiffEnvironment } from "./environment.js";
import { startWingdiffServer } from "./server.js";
import { defaultDatabasePath } from "./sessions.js";
import { parsePullRequestTarget, repositoryFromRemoteUrl, type PullRequestTarget } from "./targets.js";

const execFile = promisify(execFileCallback);

export interface CliOptions {
  target?: string;
  checkout?: string;
  demo: boolean;
  openBrowser: boolean;
  help: boolean;
}

export function parseCliArguments(arguments_: string[]): CliOptions {
  let target: string | undefined;
  let checkout: string | undefined;
  let demo = false;
  let openBrowser = true;
  let help = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--demo") demo = true;
    else if (argument === "--no-open") openBrowser = false;
    else if (argument === "--help" || argument === "-h") help = true;
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

  if (demo && target) throw new Error("Use either --demo or a pull request target, not both.");
  return { target, ...(checkout ? { checkout } : {}), demo, openBrowser, help };
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

async function run() {
  loadWingdiffEnvironment();
  const options = parseCliArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  const workingDirectory = resolveWorkingDirectory(options.checkout, process.env.INIT_CWD);
  const checkoutRepository = options.target && /^#?\d+$/.test(options.target)
    ? await repositoryForCheckout(workingDirectory)
    : undefined;
  const target = options.target ? parsePullRequestTarget(options.target, checkoutRepository) : undefined;
  const discoveryPath = serverDiscoveryPath(process.env);
  const existing = await readServerDiscovery(discoveryPath);
  if (existing && await isWingdiffRunning(existing.url, existing.authToken)) {
    if (path.resolve(existing.cwd) !== workingDirectory) {
      throw new Error(`Wingdiff is already running for ${existing.cwd}. Stop it before launching for ${workingDirectory}.`);
    }
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
  return `wingdiff — guided pull request review\n\nUsage:\n  wingdiff [pull-request]\n  wingdiff --checkout <path> [pull-request]\n  wingdiff --demo\n\nTargets:\n  https://github.com/owner/repo/pull/123\n  owner/repo#123\n  123                         Resolve from the selected checkout\n\nOptions:\n  --checkout <path>           Use this local repository checkout\n  --demo                      Open the fixture review\n  --no-open                   Start without opening a browser\n  -h, --help                  Show this help\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : "Wingdiff could not start.";
    process.stderr.write(`wingdiff: ${message}\n`);
    process.exitCode = 1;
  });
}
