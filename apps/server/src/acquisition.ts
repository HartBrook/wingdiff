import { readDiffEvidence, type PullRequestEvidence } from "./diff.js";
import { acquirePinnedRevisions, type PinnedRevisions } from "./git.js";
import type { PullRequestMetadata } from "./github.js";
import { readCodeReviewMetadata } from "./hosting.js";
import { inspectLocalTarget, MINIMUM_GITLAB_CLI_VERSION, type LocalTargetPreflight } from "./preflight.js";
import { SessionStore, type ReviewSession } from "./sessions.js";
import { codeHostName, targetRepositoryKey, type PullRequestTarget } from "./targets.js";

export type AcquisitionStage = "preflight" | "metadata" | "revisions" | "evidence" | "persisting" | "update-evidence";

export interface ReviewRefreshResult {
  status: "current" | "updated";
  session: ReviewSession;
  update?: ReturnType<SessionStore["saveReviewUpdate"]>;
}

export interface AcquisitionDependencies {
  inspectTarget: (target: PullRequestTarget, cwd: string) => Promise<LocalTargetPreflight>;
  readMetadata: (target: PullRequestTarget, cwd: string) => Promise<PullRequestMetadata>;
  acquireRevisions: (target: PullRequestTarget, metadata: PullRequestMetadata, cwd: string) => Promise<PinnedRevisions>;
  readEvidence: (revisions: PinnedRevisions) => Promise<PullRequestEvidence>;
}

const defaultDependencies: AcquisitionDependencies = {
  inspectTarget: inspectLocalTarget,
  readMetadata: readCodeReviewMetadata,
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
  return (await acquireReviewArtifacts(target, cwd, store, onStage, dependencies)).session;
}

export async function refreshReviewSession(
  target: PullRequestTarget,
  cwd: string,
  store: SessionStore,
  onStage: (stage: AcquisitionStage) => void = () => undefined,
  dependencies: AcquisitionDependencies = defaultDependencies,
): Promise<ReviewRefreshResult> {
  const baseline = store.latestCheckpointForPullRequest(targetRepositoryKey(target), target.number);
  if (!baseline) throw new Error("Complete this review before checking for author updates.");

  const acquired = await acquireReviewArtifacts(target, cwd, store, onStage, dependencies);
  if (acquired.session.metadata.head.sha === baseline.reviewedHeadSha) {
    return { status: "current", session: acquired.session };
  }

  onStage("update-evidence");
  const evidence = await dependencies.readEvidence({
    repositoryRoot: acquired.revisions.repositoryRoot,
    base: {
      sha: baseline.reviewedHeadSha,
      ref: `refs/wingdiff/${target.platform === "gitlab" ? "merge-request" : "pull"}/${target.number}/revisions/${baseline.reviewedHeadSha}`,
    },
    head: acquired.revisions.head,
  });
  if (evidence.baseSha !== baseline.reviewedHeadSha || evidence.headSha !== acquired.session.metadata.head.sha) {
    throw new Error("Update evidence does not match the reviewed and current head revisions.");
  }
  const update = store.saveReviewUpdate(acquired.session.id, baseline.sessionId, evidence);
  return { status: "updated", session: acquired.session, update };
}

async function acquireReviewArtifacts(
  target: PullRequestTarget,
  cwd: string,
  store: SessionStore,
  onStage: (stage: AcquisitionStage) => void,
  dependencies: AcquisitionDependencies,
): Promise<{ session: ReviewSession; revisions: PinnedRevisions }> {
  onStage("preflight");
  const preflight = await dependencies.inspectTarget(target, cwd);
  if (preflight.checkout.status !== "matched" || !preflight.checkout.path) {
    const actual = preflight.checkout.repository ? ` Current checkout: ${preflight.checkout.repository}.` : "";
    throw new Error(`Launch Wingdiff from a checkout of ${target.owner}/${target.repository}.${actual}`);
  }
  const hostName = codeHostName(target);
  if (!preflight.hostingCli.installed) {
    throw new Error(`${hostName} CLI is not installed. Install ${preflight.hostingCli.command}, then run: ${preflight.hostingCli.command} auth login`);
  }
  if (!preflight.hostingCli.supported) {
    const found = preflight.hostingCli.version ? ` Found ${preflight.hostingCli.version}.` : "";
    throw new Error(`GitLab CLI ${MINIMUM_GITLAB_CLI_VERSION} or later is required.${found} Upgrade glab and try again.`);
  }
  if (!preflight.hostingCli.authenticated) {
    throw new Error(`${hostName} CLI is not authenticated for ${target.host}. Run: ${preflight.hostingCli.command} auth login${target.host === "gitlab.com" || target.host === "github.com" ? "" : ` --hostname ${target.host}`}`);
  }

  onStage("metadata");
  const metadata = await dependencies.readMetadata(target, preflight.checkout.path);
  onStage("revisions");
  const revisions = await dependencies.acquireRevisions(target, metadata, preflight.checkout.path);
  onStage("evidence");
  const evidence = await dependencies.readEvidence(revisions);
  const expectedBaseSha = revisions.comparisonBase?.sha ?? revisions.base.sha;
  if (evidence.baseSha !== expectedBaseSha || evidence.headSha !== metadata.head.sha) {
    throw new Error("Acquired evidence does not match the review request's pinned revisions.");
  }

  onStage("persisting");
  const normalizedMetadata = {
    ...metadata,
    additions: evidence.additions,
    deletions: evidence.deletions,
    filesChanged: evidence.files.length,
  };
  return { session: store.upsertReadySession(target, normalizedMetadata, evidence, revisions.repositoryRoot), revisions };
}
