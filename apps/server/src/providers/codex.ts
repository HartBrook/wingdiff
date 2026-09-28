import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildInvestigationPrompt, INVESTIGATION_INSTRUCTIONS } from "./prompt.js";
import type { InvestigationContext, ModelSelection, TextProvider } from "./types.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_ERROR_LENGTH = 1_200;

export function codexCliReady(
  executable: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  const result = spawnSync(executable, ["login", "status"], {
    encoding: "utf8",
    env: environment,
    timeout: 3_000,
    windowsHide: true,
  });
  return result.status === 0;
}

export class CodexCliProvider implements TextProvider {
  readonly id = "codex" as const;

  constructor(
    private readonly executable = "codex",
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async *streamInvestigation(
    selection: ModelSelection,
    context: InvestigationContext,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    const workingDirectory = await mkdtemp(path.join(tmpdir(), "wingdiff-codex-"));
    const timeoutMs = parseTimeout(this.environment.WINGDIFF_CODEX_TIMEOUT_MS);
    const prompt = `${INVESTIGATION_INSTRUCTIONS}\n\nDo not use tools, inspect the filesystem, or execute commands. Answer only from the review evidence below.\n\n${buildInvestigationPrompt(context)}`;
    const child = spawn(this.executable, [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--model",
      selection.model,
      "-c",
      `model_reasoning_effort="${selection.reasoningEffort}"`,
      "-",
    ], {
      cwd: workingDirectory,
      env: this.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    let stderr = "";
    let timedOut = false;
    const abort = () => child.kill("SIGTERM");
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_ERROR_LENGTH);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);

    try {
      child.stdout.setEncoding("utf8");
      for await (const chunk of child.stdout) {
        yield chunk as string;
      }

      const exitCode = await completion;
      if (signal?.aborted) throw new Error("Codex CLI investigation was canceled.");
      if (timedOut) throw new Error(`Codex CLI exceeded the ${Math.round(timeoutMs / 1_000)} second timeout.`);
      if (exitCode !== 0) {
        throw new Error(cleanCliError(stderr) || `Codex CLI exited with status ${String(exitCode)}.`);
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }
}

function parseTimeout(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : DEFAULT_TIMEOUT_MS;
}

function cleanCliError(stderr: string): string {
  return stderr
    .replace(/WARNING: proceeding, even though we could not create PATH aliases:[^\n]*\n?/g, "")
    .trim();
}
