import { spawn } from "node:child_process";
import { validateDraftComment } from "./comments.js";
import type { PullRequestMetadata } from "./github.js";
import { publishGitLabMergeRequestReview, type GitLabLineEndpoint, type GitLabReviewComment, type PinnedReviewRevisions } from "./gitlab.js";
import { readCodeReviewMetadata } from "./hosting.js";
import type { DraftReviewComment, ReviewDraft, ReviewSession, SessionStore, SubmittedReview, TourScope } from "./sessions.js";
import { codeHostName, type PullRequestTarget } from "./targets.js";
import { approvalWarnings } from "./reviewWorkflow.js";

export interface PublishedReview {
  id: number;
  url: string;
  state: string;
}

export interface ReviewSubmissionDependencies {
  readMetadata: (target: PullRequestTarget, cwd: string) => Promise<PullRequestMetadata>;
  publishReview: (
    target: PullRequestTarget,
    cwd: string,
    pinned: PinnedReviewRevisions,
    draft: Pick<ReviewDraft, "body" | "event">,
    comments: GitLabReviewComment[],
  ) => Promise<PublishedReview>;
}

const defaultDependencies: ReviewSubmissionDependencies = {
  readMetadata: readCodeReviewMetadata,
  publishReview: publishCodeReview,
};

export async function submitSessionReview(
  session: ReviewSession,
  store: SessionStore,
  cwd: string,
  draft: Pick<ReviewDraft, "body" | "event">,
  dependencies: ReviewSubmissionDependencies = defaultDependencies,
  reviewContext: { scope: TourScope; acknowledgeApprovalRisks: boolean } = { scope: "full", acknowledgeApprovalRisks: true },
): Promise<SubmittedReview> {
  if (store.getSubmittedReview(session.id, session.metadata.head.sha)) {
    throw new Error("A review has already been published for this pinned head.");
  }
  const current = await dependencies.readMetadata(session.target, cwd);
  if (current.head.sha !== session.metadata.head.sha) {
    throw new Error(`The ${session.target.platform === "gitlab" ? "merge" : "pull"} request head changed from ${session.metadata.head.sha.slice(0, 7)} to ${current.head.sha.slice(0, 7)}. Check for updates before publishing.`);
  }
  if (session.target.platform === "gitlab" && (
    current.base.sha !== session.metadata.base.sha
    || (current.diffRefs && session.metadata.diffRefs && current.diffRefs.baseSha !== session.metadata.diffRefs.baseSha)
  )) {
    throw new Error(`The merge request's target branch moved from ${session.metadata.base.sha.slice(0, 7)} to ${current.base.sha.slice(0, 7)}, so GitLab now compares a different diff. Reopen the merge request in Wingdiff before publishing.`);
  }
  if (current.state.toUpperCase() !== "OPEN") throw new Error(`This review request is ${current.state.toLowerCase()} and cannot receive a review.`);
  if (draft.event === "APPROVE") {
    const warnings = approvalWarnings(session, store, reviewContext.scope);
    if (current.checks.failed && !warnings.some((warning) => warning.includes("required check"))) {
      warnings.push(`${current.checks.failed} required check${current.checks.failed === 1 ? " is" : "s are"} failing.`);
    }
    if (warnings.length && !reviewContext.acknowledgeApprovalRisks) {
      throw new Error(`Approval requires explicit acknowledgement: ${warnings.join(" ")}`);
    }
  }

  const comments = store.listDraftComments(session.id);
  comments.forEach((comment) => validateDraftComment(comment, session.evidence));
  if (!draft.body.trim() && draft.event !== "APPROVE") throw new Error(`${draft.event === "COMMENT" ? "Comment" : "Request changes"} reviews require a summary.`);
  if (!draft.body.trim() && comments.length === 0) throw new Error("Add a review summary or an inline comment before publishing.");

  store.beginReviewPublication(session.id, session.metadata.head.sha, draft, comments);
  let published: PublishedReview;
  try {
    const hostedComments = comments.map((comment) => {
      const file = session.evidence.files.find((candidate) => candidate.path === comment.path);
      const lines = file?.hunks.flatMap((hunk) => hunk.lines) ?? [];
      const selectedLine = (line: (typeof lines)[number], number: number) => (
        comment.side === "LEFT" ? line.oldLine === number : line.newLine === number
      );
      const start = lines.find((line) => selectedLine(line, comment.startLine));
      const end = lines.find((line) => selectedLine(line, comment.endLine));
      // GitLab line codes use the running old/new counters, which added and removed lines still carry.
      const endpoint = (number: number): GitLabLineEndpoint | undefined => {
        for (const hunk of file?.hunks ?? []) {
          let oldPosition = hunk.oldStart;
          let newPosition = hunk.newStart;
          for (const line of hunk.lines) {
            if (selectedLine(line, number)) return { kind: line.kind, oldPosition, newPosition };
            if (line.kind !== "addition") oldPosition += 1;
            if (line.kind !== "deletion") newPosition += 1;
          }
        }
        return undefined;
      };
      const startEndpoint = endpoint(comment.startLine);
      const endEndpoint = endpoint(comment.endLine);
      return {
        ...comment,
        oldPath: file?.oldPath ?? comment.path,
        ...(startEndpoint ? { startEndpoint } : {}),
        ...(endEndpoint ? { endEndpoint } : {}),
        ...(start?.oldLine ? { startOldLine: start.oldLine } : {}),
        ...(start?.newLine ? { startNewLine: start.newLine } : {}),
        ...(end?.oldLine ? { endOldLine: end.oldLine } : {}),
        ...(end?.newLine ? { endNewLine: end.newLine } : {}),
      };
    });
    const pinned: PinnedReviewRevisions = {
      headSha: session.metadata.head.sha,
      startSha: session.metadata.base.sha,
      ...(session.metadata.diffRefs ? { baseSha: session.metadata.diffRefs.baseSha } : {}),
    };
    published = await dependencies.publishReview(session.target, cwd, pinned, draft, hostedComments);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${codeHostName(session.target)} review publication failed.`;
    store.markReviewPublicationUncertain(session.id, session.metadata.head.sha, message);
    throw new Error(`${message} The publication outcome is uncertain; verify ${codeHostName(session.target)} before allowing a retry.`);
  }
  return store.completeReviewPublication(
    session.id, session.metadata.head.sha, published.id, published.url, draft, comments,
  );
}

export type GitHubApiRunner = (arguments_: string[], cwd: string, input: string) => Promise<string>;

export async function publishPullRequestReview(
  target: PullRequestTarget,
  cwd: string,
  headSha: string,
  draft: Pick<ReviewDraft, "body" | "event">,
  comments: DraftReviewComment[],
  runCommand: GitHubApiRunner = defaultGitHubApiRunner,
): Promise<PublishedReview> {
  const payload = {
    commit_id: headSha,
    body: draft.body.trim(),
    event: draft.event,
    comments: comments.map((comment) => ({
      path: comment.path,
      body: comment.body,
      line: comment.endLine,
      side: comment.side,
      ...(comment.startLine === comment.endLine ? {} : { start_line: comment.startLine, start_side: comment.side }),
    })),
  };
  const output = await runCommand([
    "api",
    "--method", "POST",
    "-H", "Accept: application/vnd.github+json",
    `repos/${target.owner}/${target.repository}/pulls/${target.number}/reviews`,
    "--input", "-",
  ], cwd, JSON.stringify(payload));

  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new Error("GitHub CLI returned an invalid review response.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("GitHub CLI returned an invalid review response.");
  const value = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(value.id) || typeof value.html_url !== "string" || !value.html_url) {
    throw new Error("GitHub CLI returned an incomplete review response.");
  }
  return { id: Number(value.id), url: value.html_url, state: typeof value.state === "string" ? value.state : draft.event };
}

export async function publishCodeReview(
  target: PullRequestTarget,
  cwd: string,
  pinned: PinnedReviewRevisions,
  draft: Pick<ReviewDraft, "body" | "event">,
  comments: GitLabReviewComment[],
): Promise<PublishedReview> {
  return target.platform === "gitlab"
    ? publishGitLabMergeRequestReview(target, cwd, pinned, draft, comments)
    : publishPullRequestReview(target, cwd, pinned.headSha, draft, comments);
}

function defaultGitHubApiRunner(arguments_: string[], cwd: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", arguments_, { cwd, stdio: ["pipe", "pipe", "pipe"] });
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
      if (outputSize > 10 * 1024 * 1024) reject(new Error("GitHub CLI review response exceeded 10 MB."));
      else if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || "GitHub CLI could not publish this review."));
    });
    child.stdin.end(input);
  });
}
