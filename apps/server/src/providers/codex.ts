import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildInvestigationPrompt, INVESTIGATION_INSTRUCTIONS } from "./prompt.js";
import { buildTourRequestPrompt, parseStructuredJson, TOUR_INSTRUCTIONS, tourJsonSchema } from "./tourPrompt.js";
import { prepareModelTourInput, type TourGenerationInput } from "../tour.js";
import type { InvestigationContext, ModelSelection, TextProvider } from "./types.js";

const DEFAULT_TOUR_TIMEOUT_MS = 600_000;
const DEFAULT_INVESTIGATION_TIMEOUT_MS = 180_000;
const MAX_ERROR_LENGTH = 1_200;

export const CODEX_SECURITY_OVERRIDES = [
  "-c",
  'shell_environment_policy.inherit="none"',
  "-c",
  "tools.web_search=false",
] as const;

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
  readonly generationTimeoutMs: number;

  constructor(
    private readonly executable = "codex",
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.generationTimeoutMs = codexTourTimeoutMs(environment);
  }

  async generateTour(
    selection: ModelSelection,
    input: TourGenerationInput,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const workingDirectory = await mkdtemp(path.join(tmpdir(), "wingdiff-codex-"));
    const schemaPath = path.join(workingDirectory, "tour-schema.json");
    const outputPath = path.join(workingDirectory, "tour-output.json");
    const model = prepareModelTourInput(input);
    await writeFile(schemaPath, JSON.stringify(tourJsonSchema(model.input)), "utf8");
    const prompt = `${TOUR_INSTRUCTIONS}\n\nDo not use tools, inspect the filesystem, or execute commands. Answer only from the review evidence below.\n\n${buildTourRequestPrompt(model.input)}`;

    try {
      await runCodex(this.executable, this.environment, workingDirectory, [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        ...CODEX_SECURITY_OVERRIDES,
        "--color",
        "never",
        ...codexModelArguments(selection.model),
        "-c",
        `model_reasoning_effort="${selection.reasoningEffort}"`,
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "-",
      ], selection.model, prompt, this.generationTimeoutMs, signal);
      return model.restoreAnchors(parseStructuredJson(await readFile(outputPath, "utf8")));
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }

  async *streamInvestigation(
    selection: ModelSelection,
    context: InvestigationContext,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    const workingDirectory = await mkdtemp(path.join(tmpdir(), "wingdiff-codex-"));
    const timeoutMs = codexInvestigationTimeoutMs(this.environment);
    const prompt = `${INVESTIGATION_INSTRUCTIONS}\n\nDo not use tools, inspect the filesystem, or execute commands. Answer only from the review evidence below.\n\n${buildInvestigationPrompt(context)}`;
    const child = spawn(this.executable, [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      ...CODEX_SECURITY_OVERRIDES,
      "--color",
      "never",
      ...codexModelArguments(selection.model),
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
        throw new Error(formatCodexCliError(stderr, selection.model) || `Codex CLI exited with status ${String(exitCode)}.`);
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }
}

async function runCodex(
  executable: string,
  environment: NodeJS.ProcessEnv,
  workingDirectory: string,
  arguments_: string[],
  model: string,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const child = spawn(executable, arguments_, {
    cwd: workingDirectory,
    env: environment,
    stdio: ["pipe", "ignore", "pipe"],
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
    const exitCode = await completion;
    if (signal?.aborted) throw new Error("Codex CLI tour generation was canceled.");
    if (timedOut) throw new Error(`Codex CLI exceeded the ${Math.round(timeoutMs / 1_000)} second timeout.`);
    if (exitCode !== 0) {
      throw new Error(formatCodexCliError(stderr, model) || `Codex CLI exited with status ${String(exitCode)}.`);
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function codexTourTimeoutMs(environment: NodeJS.ProcessEnv): number {
  return parseTimeout(
    environment.WINGDIFF_CODEX_TOUR_TIMEOUT_MS ?? environment.WINGDIFF_CODEX_TIMEOUT_MS,
    DEFAULT_TOUR_TIMEOUT_MS,
  );
}

export function codexInvestigationTimeoutMs(environment: NodeJS.ProcessEnv): number {
  return parseTimeout(
    environment.WINGDIFF_CODEX_INVESTIGATION_TIMEOUT_MS ?? environment.WINGDIFF_CODEX_TIMEOUT_MS,
    DEFAULT_INVESTIGATION_TIMEOUT_MS,
  );
}

export function codexModelArguments(model: string): string[] {
  return model === "codex-default" ? [] : ["--model", model];
}

function parseTimeout(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : fallback;
}

function cleanCliError(stderr: string): string {
  return stderr
    .replace(/WARNING: proceeding, even though we could not create PATH aliases:[^\n]*\n?/g, "")
    .trim();
}

export function formatCodexCliError(stderr: string, model?: string): string {
  const cleaned = cleanCliError(stderr);
  if (!cleaned) return "";
  // Codex streams the prompt and model prose to stderr, so only the line that reports the failure is classified.
  const lines = cleaned.split("\n").map((candidate) => candidate.trim()).filter(Boolean).reverse();
  const errorLine = lines.find((candidate) => CLI_ERROR_LINE.test(candidate));
  const reported = errorLine ?? lines.find((candidate) => !CLI_WARNING_LINE.test(candidate)) ?? cleaned;
  const modelName = model === "codex-default" ? "Codex's account-default model" : model ?? "The selected model";

  if (/(?:not supported|unsupported) when using Codex with a ChatGPT account/i.test(reported)) {
    return `${modelName} is not available with this ChatGPT account. Update Codex CLI and run \`codex login\` again, or select OpenAI API and configure OPENAI_API_KEY.`;
  }
  if (/(?:not logged in|log in to Codex|authentication (?:is )?(?:missing|required|expired)|status["': ]+401|\b401 Unauthorized\b)/i.test(reported)) {
    return "Codex authentication is missing or expired. Run `codex login`, then restart Wingdiff.";
  }
  if (/\bmodel\b.*(?:not supported|not available|does not exist|do not have access)/i.test(reported)) {
    return `${modelName} is not available with the current Codex sign-in. Update Codex CLI and run \`codex login\` again, or choose another provider.`;
  }
  return errorLine ? extractCliErrorDetail(errorLine) : cleaned;
}

const CLI_LOG_TIMESTAMP = String.raw`(?:\d{4}-\d\d-\d\dT\S+\s+)?`;
const CLI_ERROR_LINE = new RegExp(`^${CLI_LOG_TIMESTAMP}(?:ERROR\\b|[Ee]rror:)`);
const CLI_WARNING_LINE = new RegExp(`^${CLI_LOG_TIMESTAMP}warn(?:ing)?\\b`, "i");

function extractCliErrorDetail(errorLine: string): string {
  const fields = [...errorLine.matchAll(/"(?:message|detail)"\s*:\s*("(?:\\.|[^"\\])*")/g)];
  const encoded = fields.at(-1)?.[1];
  if (encoded) {
    try {
      return JSON.parse(encoded) as string;
    } catch {
      // Fall back to the error line itself below.
    }
  }
  return errorLine
    .replace(/^\d{4}-\d\d-\d\dT\S+\s+ERROR\s+[^:]+:\s*/, "")
    .replace(/^error:\s*/i, "")
    .trim();
}
