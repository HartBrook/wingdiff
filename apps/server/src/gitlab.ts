import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { EvidenceLineKind } from "./diff.js";
import type { PullRequestMetadata } from "./github.js";
import { versionAtLeast } from "./preflight.js";
import type { DraftReviewComment, ReviewDraft } from "./sessions.js";
import type { PullRequestTarget } from "./targets.js";
import { targetRepositoryPath } from "./targets.js";

const execFile = promisify(execFileCallback);

export const MINIMUM_GITLAB_SERVER_VERSION = "19.2.0";

export type GitLabCommandRunner = (arguments_: string[], cwd: string) => Promise<string>;
export type GitLabApiRunner = (arguments_: string[], cwd: string, input?: string) => Promise<string>;
/** A diff line as GitLab's parser sees it: its kind plus the running old/new counters at that line. */
export interface GitLabLineEndpoint {
  kind: EvidenceLineKind;
  oldPosition: number;
  newPosition: number;
}

export type GitLabReviewComment = DraftReviewComment & {
  oldPath?: string;
  startEndpoint?: GitLabLineEndpoint;
  endEndpoint?: GitLabLineEndpoint;
  startOldLine?: number;
  startNewLine?: number;
  endOldLine?: number;
  endNewLine?: number;
};

interface GitLabDiffRefs {
  baseSha: string;
  headSha: string;
  startSha: string;
}

/** The revisions a review was made against; publication is refused if GitLab now compares anything else. */
export interface PinnedReviewRevisions {
  headSha: string;
  startSha: string;
  /** Absent for sessions acquired before diff refs were stored; it is determined by startSha and headSha. */
  baseSha?: string;
}

export async function readGitLabMergeRequestMetadata(
  target: PullRequestTarget,
  cwd: string,
  runCommand: GitLabCommandRunner = defaultGitLabCommandRunner,
): Promise<PullRequestMetadata> {
  assertGitLabTarget(target);
  const versionOutput = await runCommand(apiArguments(target, "version"), cwd);
  assertSupportedGitLabServerVersion(versionOutput);
  const endpoint = mergeRequestEndpoint(target);
  const [mergeRequestOutput, commitsOutput, diffsOutput, approvalsOutput] = await Promise.all([
    runCommand(apiArguments(target, endpoint), cwd),
    // --paginate writes each page's array back to back, so request one JSON value per line instead.
    runCommand([...apiArguments(target, `${endpoint}/commits?per_page=100`), "--paginate", "--output", "ndjson"], cwd),
    runCommand([...apiArguments(target, `${endpoint}/diffs?per_page=100`), "--paginate", "--output", "ndjson"], cwd),
    runCommand(apiArguments(target, `${endpoint}/approvals`), cwd).catch(() => "{}"),
  ]);
  try {
    return normalizeGitLabMergeRequestMetadata(
      JSON.parse(mergeRequestOutput),
      parseJsonLines(commitsOutput),
      parseJsonLines(diffsOutput),
      JSON.parse(approvalsOutput),
      target,
    );
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("GitLab CLI returned invalid merge request metadata.");
    throw error;
  }
}

export function normalizeGitLabMergeRequestMetadata(
  rawMergeRequest: unknown,
  rawCommits: unknown,
  rawDiffs: unknown,
  rawApprovals: unknown,
  target: PullRequestTarget,
): PullRequestMetadata {
  assertGitLabTarget(target);
  const mergeRequest = object(rawMergeRequest, "GitLab merge request metadata");
  const returnedUrl = text(mergeRequest.web_url, "web URL").replace(/\/$/, "");
  if (returnedUrl.toLowerCase() !== target.canonicalUrl.toLowerCase()) {
    throw new Error(`GitLab returned ${returnedUrl}, but Wingdiff requested ${target.label}.`);
  }
  const author = object(mergeRequest.author, "author");
  const refs = diffRefs(mergeRequest.diff_refs);
  const diffs = array(rawDiffs).map((value) => object(value, "merge request diff"));
  const commits = array(rawCommits).map((value) => {
    const commit = object(value, "commit");
    return {
      sha: sha(commit.id, "commit id"),
      message: text(commit.title, "commit title"),
      ...(optionalText(commit.authored_date) ? { authoredAt: optionalText(commit.authored_date) } : {}),
    };
  });
  const approvals = objectOrEmpty(rawApprovals);
  const approvedBy = array(approvals.approved_by);
  const checks = summarizePipeline(mergeRequest.head_pipeline ?? mergeRequest.pipeline);
  const lineCounts = countDiffLines(diffs);

  return {
    number: integer(mergeRequest.iid, "IID"),
    repository: targetRepositoryPath(target),
    url: target.canonicalUrl,
    title: text(mergeRequest.title, "title"),
    body: optionalText(mergeRequest.description) ?? "",
    author: {
      login: text(author.username, "author username"),
      ...(optionalText(author.name) ? { name: optionalText(author.name) } : {}),
    },
    base: { ref: text(mergeRequest.target_branch, "target branch"), sha: refs.startSha },
    head: { ref: text(mergeRequest.source_branch, "source branch"), sha: refs.headSha },
    diffRefs: refs,
    additions: lineCounts.additions,
    deletions: lineCounts.deletions,
    filesChanged: Math.max(diffs.length, countChanges(mergeRequest.changes_count)),
    commits,
    checks,
    reviews: {
      count: approvedBy.length,
      ...(approvedBy.length ? { decision: "APPROVED" } : {}),
    },
    state: normalizeState(text(mergeRequest.state, "state")),
    draft: mergeRequest.draft === true || mergeRequest.work_in_progress === true,
    updatedAt: text(mergeRequest.updated_at, "updated at"),
  };
}

export async function publishGitLabMergeRequestReview(
  target: PullRequestTarget,
  cwd: string,
  pinned: PinnedReviewRevisions,
  draft: Pick<ReviewDraft, "body" | "event">,
  comments: GitLabReviewComment[],
  runCommand: GitLabApiRunner = defaultGitLabApiRunner,
): Promise<{ id: number; url: string; state: string }> {
  assertGitLabTarget(target);
  const endpoint = mergeRequestEndpoint(target);
  const refs = await readLatestGitLabDiffRefs(target, endpoint, cwd, runCommand);
  assertPinnedRevisions(pinned, refs);
  const headSha = pinned.headSha;

  // bulk_publish publishes every pending draft the user has on this merge request, so refuse to
  // run while drafts Wingdiff did not create are waiting.
  const pendingOutput = await runCommand(apiArguments(target, `${endpoint}/draft_notes?per_page=100`), cwd);
  let pending: unknown;
  try {
    pending = JSON.parse(pendingOutput);
  } catch {
    throw new Error("GitLab CLI returned an invalid draft note list.");
  }
  if (array(pending).length) {
    throw new Error("You have pending GitLab draft notes on this merge request. Submit or discard them in GitLab before publishing from Wingdiff.");
  }

  let receiptId = target.number;
  const createdDraftIds: number[] = [];
  try {
    for (const comment of comments) {
      const path = comment.path;
      const position = {
        position_type: "text",
        base_sha: refs.baseSha,
        head_sha: refs.headSha,
        start_sha: refs.startSha,
        old_path: comment.oldPath ?? path,
        new_path: path,
        ...gitLabLinePair(comment.endLine, comment.endOldLine, comment.endNewLine, comment.side),
        ...(comment.startLine === comment.endLine ? {} : {
          line_range: {
            start: gitLabLineRangePoint(comment, "start"),
            end: gitLabLineRangePoint(comment, "end"),
          },
        }),
      };
      const output = await runCommand(
        apiArguments(target, `${endpoint}/draft_notes`, "POST", true),
        cwd,
        JSON.stringify({ note: comment.body, position }),
      );
      let created: Record<string, unknown>;
      try {
        created = object(JSON.parse(output), "GitLab draft note response");
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error("GitLab CLI returned an invalid draft note response.");
        throw error;
      }
      if (Number.isSafeInteger(created.id)) {
        receiptId = Number(created.id);
        createdDraftIds.push(receiptId);
      }
    }
  } catch (error) {
    // Remove this attempt's drafts so a retry does not publish duplicates alongside them.
    await deleteDraftNotes(target, endpoint, createdDraftIds, cwd, runCommand);
    throw error;
  }

  // Draft creation is not atomic with publication. Recheck after the last draft so an author
  // push during this attempt cannot knowingly publish comments against an obsolete diff.
  try {
    assertPinnedRevisions(pinned, await readLatestGitLabDiffRefs(target, endpoint, cwd, runCommand));
  } catch (error) {
    await deleteDraftNotes(target, endpoint, createdDraftIds, cwd, runCommand);
    throw error;
  }

  await runCommand(
    apiArguments(target, `${endpoint}/draft_notes/bulk_publish`, "POST", true),
    cwd,
    JSON.stringify({
      ...(draft.body.trim() ? { note: draft.body.trim() } : {}),
      reviewer_state: draft.event === "REQUEST_CHANGES" ? "requested_changes" : "reviewed",
    }),
  );

  if (draft.event === "APPROVE") {
    await runCommand(
      apiArguments(target, `${endpoint}/approve`, "POST", true),
      cwd,
      JSON.stringify({ sha: headSha }),
    );
  }
  return { id: receiptId, url: target.canonicalUrl, state: draft.event };
}

export function assertSupportedGitLabServerVersion(output: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new Error("GitLab CLI returned invalid server version metadata.");
  }
  const value = object(raw, "GitLab server version metadata");
  const reported = text(value.version, "GitLab server version");
  const version = /^(\d+\.\d+\.\d+)/.exec(reported)?.[1];
  if (!version) throw new Error("GitLab server version is missing or invalid.");
  if (!versionAtLeast(version, MINIMUM_GITLAB_SERVER_VERSION)) {
    throw new Error(`GitLab ${MINIMUM_GITLAB_SERVER_VERSION} or later is required for review publication. ${reported} is not supported.`);
  }
}

async function readLatestGitLabDiffRefs(
  target: PullRequestTarget,
  endpoint: string,
  cwd: string,
  runCommand: GitLabApiRunner,
): Promise<GitLabDiffRefs> {
  const versionOutput = await runCommand(apiArguments(target, `${endpoint}/versions`), cwd);
  let versions: unknown;
  try {
    versions = JSON.parse(versionOutput);
  } catch {
    throw new Error("GitLab CLI returned invalid merge request version metadata.");
  }
  const latest = object(array(versions)[0], "latest GitLab merge request version");
  return {
    baseSha: sha(latest.base_commit_sha, "version base SHA"),
    headSha: sha(latest.head_commit_sha, "version head SHA"),
    startSha: sha(latest.start_commit_sha, "version start SHA"),
  };
}

async function deleteDraftNotes(
  target: PullRequestTarget,
  endpoint: string,
  ids: number[],
  cwd: string,
  runCommand: GitLabApiRunner,
): Promise<void> {
  await Promise.allSettled(ids.map((id) =>
    runCommand(apiArguments(target, `${endpoint}/draft_notes/${id}`, "DELETE"), cwd)));
}

function gitLabLineRangePoint(comment: GitLabReviewComment, point: "start" | "end") {
  const selectedLine = point === "start" ? comment.startLine : comment.endLine;
  const oldLine = point === "start" ? comment.startOldLine : comment.endOldLine;
  const newLine = point === "start" ? comment.startNewLine : comment.endNewLine;
  const endpoint = point === "start" ? comment.startEndpoint : comment.endEndpoint;
  const { old_line: effectiveOldLine, new_line: effectiveNewLine } = gitLabLinePair(selectedLine, oldLine, newLine, comment.side);
  // GitLab hashes the file's new path for every line, including old-side lines of a renamed file.
  const pathHash = createHash("sha1").update(comment.path).digest("hex");
  const oldPosition = endpoint?.oldPosition ?? effectiveOldLine ?? 0;
  const newPosition = endpoint?.newPosition ?? effectiveNewLine ?? 0;
  // GitLab documents "new" for added lines and "old" for everything else, including context lines.
  const type = endpoint ? endpoint.kind === "addition" ? "new" : "old" : comment.side === "LEFT" ? "old" : "new";
  return {
    line_code: `${pathHash}_${oldPosition}_${newPosition}`,
    type,
    ...(effectiveOldLine ? { old_line: effectiveOldLine } : {}),
    ...(effectiveNewLine ? { new_line: effectiveNewLine } : {}),
  };
}

function assertPinnedRevisions(pinned: PinnedReviewRevisions, refs: GitLabDiffRefs): void {
  const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  if (!same(refs.headSha, pinned.headSha)) {
    throw new Error(`The merge request moved from ${pinned.headSha.slice(0, 7)} to ${refs.headSha.slice(0, 7)} during publication.`);
  }
  if (!same(refs.startSha, pinned.startSha) || (pinned.baseSha && !same(refs.baseSha, pinned.baseSha))) {
    throw new Error(`The merge request's target branch moved from ${pinned.startSha.slice(0, 7)} to ${refs.startSha.slice(0, 7)}, so GitLab now compares a different diff. Reopen the merge request in Wingdiff before publishing.`);
  }
}

/** Context lines exist on both sides, and GitLab rejects their positions unless both numbers are sent. */
function gitLabLinePair(
  selectedLine: number,
  oldLine: number | undefined,
  newLine: number | undefined,
  side: GitLabReviewComment["side"],
): { old_line?: number; new_line?: number } {
  const effectiveOldLine = oldLine ?? (side === "LEFT" ? selectedLine : undefined);
  const effectiveNewLine = newLine ?? (side === "RIGHT" ? selectedLine : undefined);
  return {
    ...(effectiveOldLine ? { old_line: effectiveOldLine } : {}),
    ...(effectiveNewLine ? { new_line: effectiveNewLine } : {}),
  };
}

function parseJsonLines(output: string): unknown[] {
  return output.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown);
}

function mergeRequestEndpoint(target: PullRequestTarget): string {
  return `projects/${encodeURIComponent(targetRepositoryPath(target))}/merge_requests/${target.number}`;
}

function apiArguments(target: PullRequestTarget, endpoint: string, method?: string, input = false): string[] {
  return [
    "api",
    "--hostname", target.host,
    ...(method ? ["--method", method] : []),
    endpoint,
    // glab sends no Content-Type for --input bodies, and GitLab needs it to parse nested JSON fields.
    ...(input ? ["--input", "-", "--header", "Content-Type: application/json"] : []),
  ];
}

function diffRefs(value: unknown): GitLabDiffRefs {
  const refs = object(value, "diff refs");
  return {
    baseSha: sha(refs.base_sha, "diff base SHA"),
    headSha: sha(refs.head_sha, "diff head SHA"),
    startSha: sha(refs.start_sha, "diff start SHA"),
  };
}

function countDiffLines(diffs: Array<Record<string, unknown>>): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const value of diffs) {
    const diff = typeof value.diff === "string" ? value.diff : "";
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
  }
  return { additions, deletions };
}

function countChanges(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+\+?$/.test(value)) return Number.parseInt(value, 10);
  return 0;
}

function summarizePipeline(value: unknown): PullRequestMetadata["checks"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { passed: 0, failed: 0, pending: 0, total: 0 };
  const status = optionalText((value as Record<string, unknown>).status)?.toUpperCase() ?? "";
  // MANUAL means the pipeline is blocked on a manual job, so it has not passed yet.
  if (["SUCCESS", "SKIPPED"].includes(status)) return { passed: 1, failed: 0, pending: 0, total: 1 };
  if (["FAILED", "CANCELED", "CANCELLED"].includes(status)) return { passed: 0, failed: 1, pending: 0, total: 1 };
  return { passed: 0, failed: 0, pending: 1, total: 1 };
}

function normalizeState(value: string): string {
  if (value.toLowerCase() === "opened") return "OPEN";
  return value.toUpperCase();
}

function assertGitLabTarget(target: PullRequestTarget) {
  if (target.platform !== "gitlab") throw new Error("A GitLab operation requires a GitLab merge request target.");
}

async function defaultGitLabCommandRunner(arguments_: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFile("glab", arguments_, { cwd, maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    throw new Error(stderr || "GitLab CLI could not read this merge request.");
  }
}

function defaultGitLabApiRunner(arguments_: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("glab", arguments_, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 10 * 1024 * 1024) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (outputSize > 10 * 1024 * 1024) reject(new Error("GitLab CLI response exceeded 10 MB."));
      else if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || "GitLab CLI could not publish this review."));
    });
    child.stdin.end(input);
  });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is missing or invalid.`);
  return value as Record<string, unknown>;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

function sha(value: unknown, label: string): string {
  const candidate = text(value, label);
  if (!/^[a-f0-9]{40}$/i.test(candidate)) throw new Error(`${label} is missing or invalid.`);
  return candidate;
}
