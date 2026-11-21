import { readPullRequestMetadata, type PullRequestMetadata } from "./github.js";
import { readGitLabMergeRequestMetadata } from "./gitlab.js";
import type { PullRequestTarget } from "./targets.js";

export async function readCodeReviewMetadata(
  target: PullRequestTarget,
  cwd: string,
): Promise<PullRequestMetadata> {
  return target.platform === "gitlab"
    ? readGitLabMergeRequestMetadata(target, cwd)
    : readPullRequestMetadata(target, cwd);
}
