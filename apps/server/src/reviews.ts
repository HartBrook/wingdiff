import { spawn } from "node:child_process";
import { validateDraftComment } from "./comments.js";
import { readPullRequestMetadata, type PullRequestMetadata } from "./github.js";
import type { DraftReviewComment, ReviewDraft, ReviewSession, SessionStore, SubmittedReview } from "./sessions.js";
import type { PullRequestTarget } from "./targets.js";

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
    headSha: string,
    draft: Pick<ReviewDraft, "body" | "event">,
    comments: DraftReviewComment[],
  ) => Promise<PublishedReview>;
}

const defaultDependencies: ReviewSubmissionDependencies = {
  readMetadata: readPullRequestMetadata,
  publishReview: publishPullRequestReview,
};

export async function submitSessionReview(
  session: ReviewSession,
  store: SessionStore,
  cwd: string,
  draft: Pick<ReviewDraft, "body" | "event">,
  dependencies: ReviewSubmissionDependencies = defaultDependencies,
): Promise<SubmittedReview> {
  if (store.getSubmittedReview(session.id, session.metadata.head.sha)) {
    throw new Error("A review has already been published for this pinned head.");
  }
  const current = await dependencies.readMetadata(session.target, cwd);
  if (current.head.sha !== session.metadata.head.sha) {
    throw new Error(`The pull request head changed from ${session.metadata.head.sha.slice(0, 7)} to ${current.head.sha.slice(0, 7)}. Check for updates before publishing.`);
  }
  if (current.state.toUpperCase() !== "OPEN") throw new Error(`This pull request is ${current.state.toLowerCase()} and cannot receive a review.`);

  const comments = store.listDraftComments(session.id);
  comments.forEach((comment) => validateDraftComment(comment, session.evidence));
  if (!draft.body.trim() && draft.event !== "APPROVE") throw new Error(`${draft.event === "COMMENT" ? "Comment" : "Request changes"} reviews require a summary.`);
  if (!draft.body.trim() && comments.length === 0) throw new Error("Add a review summary or an inline comment before publishing.");

  const published = await dependencies.publishReview(session.target, cwd, session.metadata.head.sha, draft, comments);
  return store.saveSubmittedReview(
    session.id,
    session.metadata.head.sha,
    published.id,
    published.url,
    draft,
    comments,
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
