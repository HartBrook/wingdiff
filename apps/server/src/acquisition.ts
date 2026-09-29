import { readDiffEvidence, type PullRequestEvidence } from "./diff.js";
import { acquirePinnedRevisions, type PinnedRevisions } from "./git.js";
import { readPullRequestMetadata, type PullRequestMetadata } from "./github.js";
import { inspectLocalTarget, type LocalTargetPreflight } from "./preflight.js";
import { SessionStore, type ReviewSession } from "./sessions.js";
import type { PullRequestTarget } from "./targets.js";

export type AcquisitionStage = "preflight" | "metadata" | "revisions" | "evidence" | "persisting";

export interface AcquisitionDependencies {
  inspectTarget: (target: PullRequestTarget, cwd: string) => Promise<LocalTargetPreflight>;
  readMetadata: (target: PullRequestTarget, cwd: string) => Promise<PullRequestMetadata>;
  acquireRevisions: (target: PullRequestTarget, metadata: PullRequestMetadata, cwd: string) => Promise<PinnedRevisions>;
  readEvidence: (revisions: PinnedRevisions) => Promise<PullRequestEvidence>;
}

const defaultDependencies: AcquisitionDependencies = {
  inspectTarget: inspectLocalTarget,
  readMetadata: readPullRequestMetadata,
  acquireRevisions: acquirePinnedRevisions,
  readEvidence: readDiffEvidence,
};

export async function acquireReviewSession(
  target: PullRequestTarget,
  cwd: string,
  store: SessionStore,
  onStage: (stage: AcquisitionStage) => void = () => undefined,
  dependencies: AcquisitionDependencies = defaultDependencies,
): Promise<ReviewSession> {
  onStage("preflight");
  const preflight = await dependencies.inspectTarget(target, cwd);
  if (preflight.checkout.status !== "matched" || !preflight.checkout.path) {
    const actual = preflight.checkout.repository ? ` Current checkout: ${preflight.checkout.repository}.` : "";
    throw new Error(`Launch Wingdiff from a checkout of ${target.owner}/${target.repository}.${actual}`);
  }
  if (!preflight.githubCli.installed) {
    throw new Error("GitHub CLI is not installed. Install gh and authenticate before opening this pull request.");
  }

  onStage("metadata");
  const metadata = await dependencies.readMetadata(target, preflight.checkout.path);
  onStage("revisions");
  const revisions = await dependencies.acquireRevisions(target, metadata, preflight.checkout.path);
  onStage("evidence");
  const evidence = await dependencies.readEvidence(revisions);
  if (evidence.baseSha !== metadata.base.sha || evidence.headSha !== metadata.head.sha) {
    throw new Error("Acquired evidence does not match the pull request's pinned revisions.");
  }

  onStage("persisting");
  return store.upsertReadySession(target, metadata, evidence);
}
