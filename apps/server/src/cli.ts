#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadWingdiffEnvironment } from "./environment.js";
import { startWingdiffServer } from "./server.js";
import { parsePullRequestTarget, repositoryFromRemoteUrl, type PullRequestTarget } from "./targets.js";

const execFile = promisify(execFileCallback);

export interface CliOptions {
  target?: string;
  demo: boolean;
  openBrowser: boolean;
  help: boolean;
}

export function parseCliArguments(arguments_: string[]): CliOptions {
  let target: string | undefined;
  let demo = false;
  let openBrowser = true;
  let help = false;

  for (const argument of arguments_) {
    if (argument === "--demo") demo = true;
    else if (argument === "--no-open") openBrowser = false;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (target) throw new Error("Wingdiff accepts one pull request target at a time.");
    else target = argument;
  }

  if (demo && target) throw new Error("Use either --demo or a pull request target, not both.");
  return { target, demo, openBrowser, help };
}

export function launchUrl(baseUrl: string, options: { demo: boolean; target?: PullRequestTarget }): string {
  const url = new URL(baseUrl);
  if (options.demo) url.searchParams.set("demo", "1");
  if (options.target) url.searchParams.set("target", options.target.canonicalUrl);
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

  const checkoutRepository = options.target && /^#?\d+$/.test(options.target)
    ? await repositoryForCheckout(process.cwd())
    : undefined;
  const target = options.target ? parsePullRequestTarget(options.target, checkoutRepository) : undefined;
  const host = process.env.WINGDIFF_HOST ?? "127.0.0.1";
  const port = process.env.WINGDIFF_PORT ?? "4173";
  const baseUrl = `http://${host}:${port}`;
  const destination = launchUrl(baseUrl, { demo: options.demo, target });

  if (await isWingdiffRunning(baseUrl)) {
    process.stdout.write(`Reusing Wingdiff at ${destination}\n`);
    if (options.openBrowser) openBrowser(destination);
    return;
  }

  const running = await startWingdiffServer();
  const runningDestination = launchUrl(running.url, { demo: options.demo, target });
  process.stdout.write(`Wingdiff is ready at ${runningDestination}\n`);
  process.stdout.write("Press Ctrl+C to stop the local server.\n");
  if (options.openBrowser) openBrowser(runningDestination);
}

async function isWingdiffRunning(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return false;
    const body = await response.json() as { service?: string };
    return body.service === "wingdiff";
  } catch {
    return false;
  }
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
  return `wingdiff — guided pull request review\n\nUsage:\n  wingdiff [pull-request]\n  wingdiff --demo\n\nTargets:\n  https://github.com/owner/repo/pull/123\n  owner/repo#123\n  123                         Resolve from the current checkout\n\nOptions:\n  --demo                      Open the fixture review\n  --no-open                   Start without opening a browser\n  -h, --help                  Show this help\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : "Wingdiff could not start.";
    process.stderr.write(`wingdiff: ${message}\n`);
    process.exitCode = 1;
  });
}
