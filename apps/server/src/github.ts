import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { PullRequestTarget } from "./targets.js";
import { parsePullRequestTarget } from "./targets.js";

const execFile = promisify(execFileCallback);

const PR_VIEW_FIELDS = [
  "additions",
  "author",
  "baseRefName",
  "baseRefOid",
  "body",
  "changedFiles",
  "commits",
  "deletions",
  "headRefName",
  "headRefOid",
  "isDraft",
  "latestReviews",
  "number",
  "reviewDecision",
  "state",
  "statusCheckRollup",
  "title",
  "updatedAt",
  "url",
] as const;

export interface PullRequestMetadata {
  number: number;
  repository: string;
  url: string;
  title: string;
  body: string;
  author: { login: string; name?: string };
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  additions: number;
  deletions: number;
  filesChanged: number;
  commits: Array<{ sha: string; message: string; authoredAt?: string }>;
  checks: { passed: number; failed: number; pending: number; total: number };
  reviews: { count: number; decision?: string };
  state: string;
  draft: boolean;
  updatedAt: string;
}

export type GitHubCommandRunner = (arguments_: string[], cwd: string) => Promise<string>;

export async function readPullRequestMetadata(
  target: PullRequestTarget,
  cwd: string,
  runCommand: GitHubCommandRunner = defaultGitHubCommandRunner,
): Promise<PullRequestMetadata> {
  const output = await runCommand([
    "pr",
    "view",
    target.canonicalUrl,
    "--json",
    PR_VIEW_FIELDS.join(","),
  ], cwd);

  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new Error("GitHub CLI returned invalid pull request metadata.");
  }
  return normalizePullRequestMetadata(raw, target);
}

export function normalizePullRequestMetadata(raw: unknown, target: PullRequestTarget): PullRequestMetadata {
  const record = object(raw, "GitHub pull request metadata");
  const returnedTarget = parsePullRequestTarget(text(record.url, "url"));
  if (returnedTarget.canonicalUrl.toLowerCase() !== target.canonicalUrl.toLowerCase()) {
    throw new Error(`GitHub returned ${returnedTarget.label}, but Wingdiff requested ${target.label}.`);
  }

  const author = object(record.author, "author");
  const commits = array(record.commits).map((value) => {
    const commit = object(value, "commit");
    return {
      sha: text(commit.oid, "commit oid"),
      message: text(commit.messageHeadline, "commit message"),
      ...(optionalText(commit.authoredDate) ? { authoredAt: optionalText(commit.authoredDate) } : {}),
    };
  });
  const checks = summarizeChecks(array(record.statusCheckRollup));

  return {
    number: integer(record.number, "number"),
    repository: `${target.owner}/${target.repository}`,
    url: returnedTarget.canonicalUrl,
    title: text(record.title, "title"),
    body: optionalText(record.body) ?? "",
    author: {
      login: text(author.login, "author login"),
      ...(optionalText(author.name) ? { name: optionalText(author.name) } : {}),
    },
    base: { ref: text(record.baseRefName, "base ref"), sha: sha(record.baseRefOid, "base sha") },
    head: { ref: text(record.headRefName, "head ref"), sha: sha(record.headRefOid, "head sha") },
    additions: integer(record.additions, "additions"),
    deletions: integer(record.deletions, "deletions"),
    filesChanged: integer(record.changedFiles, "changed files"),
    commits,
    checks,
    reviews: {
      count: array(record.latestReviews).length,
      ...(optionalText(record.reviewDecision) ? { decision: optionalText(record.reviewDecision) } : {}),
    },
    state: text(record.state, "state"),
    draft: boolean(record.isDraft, "draft state"),
    updatedAt: text(record.updatedAt, "updated at"),
  };
}

function summarizeChecks(values: unknown[]): PullRequestMetadata["checks"] {
  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const value of values) {
    const check = object(value, "status check");
    const state = (optionalText(check.conclusion) ?? optionalText(check.state) ?? optionalText(check.status) ?? "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state)) passed += 1;
    else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(state)) failed += 1;
    else pending += 1;
  }

  return { passed, failed, pending, total: values.length };
}

async function defaultGitHubCommandRunner(arguments_: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFile("gh", arguments_, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    throw new Error(stderr || "GitHub CLI could not read this pull request.");
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is missing or invalid.`);
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing or invalid.`);
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is missing or invalid.`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is missing or invalid.`);
  return value;
}

function sha(value: unknown, label: string): string {
  const candidate = text(value, label);
  if (!/^[a-f0-9]{40}$/i.test(candidate)) throw new Error(`${label} is missing or invalid.`);
  return candidate;
}
