import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PullRequestEvidence } from "./diff.js";
import type { PullRequestMetadata } from "./github.js";
import type { ModelSelection } from "./providers/types.js";
import type { GeneratedTour } from "./tour.js";
import type { TourEvidenceAnchor } from "./tour.js";
import type { SessionContextManifest } from "./context.js";
import { parsePullRequestTarget, type PullRequestTarget } from "./targets.js";

export type SessionStatus = "acquiring" | "ready" | "failed";
export type TourScope = "full" | "update";
export type ReviewProgressStatus = "unseen" | "understood" | "flagged" | "skipped";

export interface ReviewSession {
  id: string;
  target: PullRequestTarget;
  metadata: PullRequestMetadata;
  evidence: PullRequestEvidence;
  status: SessionStatus;
  repositoryPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewCheckpoint {
  reviewedHeadSha: string;
  completedAt: string;
  scope: TourScope;
  coverage: Record<string, string>;
  findingRevisions: FindingCheckpoint[];
}

export interface FindingCheckpoint {
  findingId: string;
  title: string;
  severity: "high" | "medium" | "low";
  state: "new" | "still-applies" | "appears-addressed" | "recheck" | "superseded" | "resolved";
  summary: string;
  pathHints: string[];
}

export interface PullRequestCheckpoint extends ReviewCheckpoint {
  sessionId: string;
  repository: string;
  pullRequestNumber: number;
}

export interface StoredReviewUpdate {
  sessionId: string;
  baselineSessionId: string;
  fromHeadSha: string;
  toHeadSha: string;
  evidence: PullRequestEvidence;
  createdAt: string;
}

export interface SessionSummary {
  id: string;
  repository: string;
  pullRequestNumber: number;
  title: string;
  headSha: string;
  status: SessionStatus;
  updatedAt: string;
}

export interface StoredTour {
  sessionId: string;
  scope: TourScope;
  selection: ModelSelection;
  baseSha: string;
  headSha: string;
  tour: GeneratedTour;
  contextFingerprint?: string;
  contextManifest?: SessionContextManifest;
  anchors?: TourEvidenceAnchor[];
  createdAt: string;
  updatedAt: string;
}

export interface DraftReviewComment {
  id: string;
  sessionId: string;
  stopId: string;
  evidenceId: string;
  path: string;
  side: "LEFT" | "RIGHT";
  startLine: number;
  endLine: number;
  body: string;
  severity: "high" | "medium" | "low";
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export type NewDraftReviewComment = Omit<DraftReviewComment, "id" | "sessionId" | "createdAt" | "updatedAt">;

export interface ReviewDraft {
  sessionId: string;
  body: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  updatedAt: string;
}

export interface SubmittedReview {
  sessionId: string;
  headSha: string;
  githubReviewId: number;
  url: string;
  event: ReviewDraft["event"];
  body: string;
  comments: DraftReviewComment[];
  submittedAt: string;
}

export interface ReviewPublicationAttempt {
  sessionId: string;
  headSha: string;
  state: "publishing" | "uncertain";
  event: ReviewDraft["event"];
  body: string;
  comments: DraftReviewComment[];
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export interface InvestigationEntry {
  id: string;
  sessionId: string;
  stopId: string;
  evidenceId: string;
  question: string;
  answer: string;
  provider: "codex" | "openai" | "anthropic";
  model: string;
  status: "streaming" | "complete" | "error";
  createdAt: string;
  updatedAt: string;
}

export interface ReviewProgressSnapshot {
  activeScope: TourScope | null;
  activeStopIds: Record<TourScope, string | null>;
  scopes: Record<TourScope, Record<string, ReviewProgressStatus>>;
}

export class SessionStore {
  readonly database: DatabaseSync;

  constructor(databasePath = defaultDatabasePath(), private readonly now: () => Date = () => new Date()) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    migrate(this.database);
    this.database.prepare("UPDATE review_publications SET state = 'uncertain' WHERE state = 'publishing'").run();
  }

  upsertReadySession(
    target: PullRequestTarget,
    metadata: PullRequestMetadata,
    evidence: PullRequestEvidence,
    repositoryPath?: string,
  ): ReviewSession {
    const existing = this.database.prepare(`
      SELECT id, created_at FROM review_sessions
      WHERE repository = ? AND pr_number = ? AND head_sha = ?
    `).get(metadata.repository, metadata.number, metadata.head.sha);
    const timestamp = this.now().toISOString();
    const id = existing ? String(existing.id) : randomUUID();
    const createdAt = existing ? String(existing.created_at) : timestamp;

    this.database.prepare(`
      INSERT INTO review_sessions (
        id, repository, pr_number, canonical_url, base_sha, head_sha, title,
        status, metadata_json, evidence_json, repository_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)
      ON CONFLICT(repository, pr_number, head_sha) DO UPDATE SET
        canonical_url = excluded.canonical_url,
        base_sha = excluded.base_sha,
        title = excluded.title,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        evidence_json = excluded.evidence_json,
        repository_path = COALESCE(excluded.repository_path, review_sessions.repository_path),
        updated_at = excluded.updated_at
    `).run(
      id,
      metadata.repository,
      metadata.number,
      target.canonicalUrl,
      metadata.base.sha,
      metadata.head.sha,
      metadata.title,
      JSON.stringify(metadata),
      JSON.stringify(evidence),
      repositoryPath ?? null,
      createdAt,
      timestamp,
    );

    return this.getSession(id)!;
  }

  getSession(id: string): ReviewSession | undefined {
    const row = this.database.prepare("SELECT * FROM review_sessions WHERE id = ?").get(id);
    if (!row) return undefined;
    return rowToSession(row);
  }

  listSessions(limit = 10): SessionSummary[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.database.prepare(`
      SELECT id, repository, pr_number, title, head_sha, status, updated_at
      FROM review_sessions ORDER BY updated_at DESC LIMIT ?
    `).all(safeLimit).map((row) => ({
      id: String(row.id),
      repository: String(row.repository),
      pullRequestNumber: Number(row.pr_number),
      title: String(row.title),
      headSha: String(row.head_sha),
      status: String(row.status) as SessionStatus,
      updatedAt: String(row.updated_at),
    }));
  }

  getReviewProgress(sessionId: string): ReviewProgressSnapshot {
    this.requireSession(sessionId);
    const rows = this.database.prepare(`
      SELECT scope, stop_id, status FROM review_progress WHERE session_id = ? ORDER BY scope, stop_id
    `).all(sessionId);
    const state = this.database.prepare("SELECT * FROM review_state WHERE session_id = ?").get(sessionId);
    const scopes: ReviewProgressSnapshot["scopes"] = { full: {}, update: {} };
    for (const row of rows) {
      const scope = String(row.scope) as TourScope;
      scopes[scope][String(row.stop_id)] = String(row.status) as ReviewProgressStatus;
    }
    return {
      activeScope: state ? String(state.active_scope) as TourScope : null,
      activeStopIds: {
        full: state?.full_stop_id ? String(state.full_stop_id) : null,
        update: state?.update_stop_id ? String(state.update_stop_id) : null,
      },
      scopes,
    };
  }

  saveReviewProgress(
    sessionId: string,
    scope: TourScope,
    activeStopId: string,
    change?: { stopId: string; status: ReviewProgressStatus },
  ): ReviewProgressSnapshot {
    this.requireSession(sessionId);
    const timestamp = this.now().toISOString();
    if (change) this.database.prepare(`
      INSERT INTO review_progress (session_id, scope, stop_id, status, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, scope, stop_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
    `).run(sessionId, scope, change.stopId, change.status, timestamp);
    const fullStopId = scope === "full" ? activeStopId : null;
    const updateStopId = scope === "update" ? activeStopId : null;
    this.database.prepare(`
      INSERT INTO review_state (session_id, active_scope, full_stop_id, update_stop_id, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        active_scope = excluded.active_scope,
        full_stop_id = COALESCE(excluded.full_stop_id, review_state.full_stop_id),
        update_stop_id = COALESCE(excluded.update_stop_id, review_state.update_stop_id),
        updated_at = excluded.updated_at
    `).run(sessionId, scope, fullStopId, updateStopId, timestamp);
    return this.getReviewProgress(sessionId);
  }

  getContextExclusions(sessionId: string, defaults: string[] = []): string[] {
    this.requireSession(sessionId);
    const row = this.database.prepare("SELECT excluded_patterns_json FROM context_settings WHERE session_id = ?").get(sessionId);
    return row ? JSON.parse(String(row.excluded_patterns_json)) as string[] : [...defaults];
  }

  saveContextExclusions(sessionId: string, patterns: string[]): string[] {
    this.requireSession(sessionId);
    const timestamp = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO context_settings (session_id, excluded_patterns_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        excluded_patterns_json = excluded.excluded_patterns_json,
        updated_at = excluded.updated_at
    `).run(sessionId, JSON.stringify(patterns), timestamp);
    this.database.prepare("DELETE FROM generated_tours WHERE session_id = ?").run(sessionId);
    return this.getContextExclusions(sessionId);
  }

  saveCheckpoint(sessionId: string, checkpoint: ReviewCheckpoint) {
    this.requireSession(sessionId);
    this.database.prepare(`
      INSERT INTO review_checkpoints (
        session_id, reviewed_head_sha, completed_at, scope, coverage_json, finding_revisions_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, reviewed_head_sha, scope) DO UPDATE SET
        completed_at = excluded.completed_at,
        scope = excluded.scope,
        coverage_json = excluded.coverage_json,
        finding_revisions_json = excluded.finding_revisions_json
    `).run(
      sessionId,
      checkpoint.reviewedHeadSha,
      checkpoint.completedAt,
      checkpoint.scope,
      JSON.stringify(checkpoint.coverage),
      JSON.stringify(checkpoint.findingRevisions),
    );
  }

  latestCheckpoint(sessionId: string, scope?: TourScope): ReviewCheckpoint | undefined {
    const row = this.database.prepare(scope ? `
      SELECT reviewed_head_sha, completed_at, scope, coverage_json, finding_revisions_json
      FROM review_checkpoints WHERE session_id = ? AND scope = ? ORDER BY completed_at DESC LIMIT 1
    ` : `
      SELECT reviewed_head_sha, completed_at, scope, coverage_json, finding_revisions_json
      FROM review_checkpoints WHERE session_id = ? ORDER BY completed_at DESC LIMIT 1
    `).get(...(scope ? [sessionId, scope] : [sessionId]));
    if (!row) return undefined;
    return {
      reviewedHeadSha: String(row.reviewed_head_sha),
      completedAt: String(row.completed_at),
      scope: String(row.scope) as TourScope,
      coverage: JSON.parse(String(row.coverage_json)) as Record<string, string>,
      findingRevisions: JSON.parse(String(row.finding_revisions_json)) as FindingCheckpoint[],
    };
  }

  latestCheckpointForPullRequest(repository: string, pullRequestNumber: number): PullRequestCheckpoint | undefined {
    const row = this.database.prepare(`
      SELECT c.*, s.id AS session_id, s.repository, s.pr_number
      FROM review_checkpoints c
      JOIN review_sessions s ON s.id = c.session_id
      WHERE s.repository = ? AND s.pr_number = ?
      ORDER BY c.completed_at DESC LIMIT 1
    `).get(repository, pullRequestNumber);
    if (!row) return undefined;
    return {
      sessionId: String(row.session_id),
      repository: String(row.repository),
      pullRequestNumber: Number(row.pr_number),
      reviewedHeadSha: String(row.reviewed_head_sha),
      completedAt: String(row.completed_at),
      scope: String(row.scope) as TourScope,
      coverage: JSON.parse(String(row.coverage_json)) as Record<string, string>,
      findingRevisions: JSON.parse(String(row.finding_revisions_json)) as FindingCheckpoint[],
    };
  }

  saveReviewUpdate(
    sessionId: string,
    baselineSessionId: string,
    evidence: PullRequestEvidence,
  ): StoredReviewUpdate {
    this.requireSession(sessionId);
    this.requireSession(baselineSessionId);
    const createdAt = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO review_updates (
        session_id, baseline_session_id, from_head_sha, to_head_sha, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        baseline_session_id = excluded.baseline_session_id,
        from_head_sha = excluded.from_head_sha,
        to_head_sha = excluded.to_head_sha,
        evidence_json = excluded.evidence_json,
        created_at = excluded.created_at
    `).run(
      sessionId,
      baselineSessionId,
      evidence.baseSha,
      evidence.headSha,
      JSON.stringify(evidence),
      createdAt,
    );
    return this.getReviewUpdate(sessionId)!;
  }

  getReviewUpdate(sessionId: string): StoredReviewUpdate | undefined {
    const row = this.database.prepare("SELECT * FROM review_updates WHERE session_id = ?").get(sessionId);
    if (!row) return undefined;
    return {
      sessionId: String(row.session_id),
      baselineSessionId: String(row.baseline_session_id),
      fromHeadSha: String(row.from_head_sha),
      toHeadSha: String(row.to_head_sha),
      evidence: JSON.parse(String(row.evidence_json)) as PullRequestEvidence,
      createdAt: String(row.created_at),
    };
  }

  saveTour(
    sessionId: string,
    scope: TourScope,
    selection: ModelSelection,
    baseSha: string,
    headSha: string,
    tour: GeneratedTour,
    provenance?: { manifest: SessionContextManifest; anchors: TourEvidenceAnchor[] },
  ): StoredTour {
    this.requireSession(sessionId);
    const timestamp = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO generated_tours (
        session_id, scope, provider, model, reasoning_effort, base_sha, head_sha, tour_json,
        context_fingerprint, context_manifest_json, anchors_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, scope) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        base_sha = excluded.base_sha,
        head_sha = excluded.head_sha,
        tour_json = excluded.tour_json,
        context_fingerprint = excluded.context_fingerprint,
        context_manifest_json = excluded.context_manifest_json,
        anchors_json = excluded.anchors_json,
        updated_at = excluded.updated_at
    `).run(
      sessionId,
      scope,
      selection.provider,
      selection.model,
      selection.reasoningEffort,
      baseSha,
      headSha,
      JSON.stringify(tour),
      provenance?.manifest.fingerprint ?? "",
      provenance ? JSON.stringify(provenance.manifest) : null,
      provenance ? JSON.stringify(provenance.anchors) : null,
      timestamp,
      timestamp,
    );
    return this.getTour(sessionId, scope)!;
  }

  getTour(sessionId: string, scope: TourScope = "full"): StoredTour | undefined {
    const row = this.database.prepare("SELECT * FROM generated_tours WHERE session_id = ? AND scope = ?").get(sessionId, scope);
    if (!row) return undefined;
    const parsedTour = JSON.parse(String(row.tour_json)) as GeneratedTour;
    return {
      sessionId: String(row.session_id),
      scope: String(row.scope) as TourScope,
      selection: {
        provider: String(row.provider) as ModelSelection["provider"],
        model: String(row.model),
        reasoningEffort: String(row.reasoning_effort) as ModelSelection["reasoningEffort"],
      },
      baseSha: String(row.base_sha),
      headSha: String(row.head_sha),
      tour: {
        ...parsedTour,
        findingRevisions: Array.isArray(parsedTour.findingRevisions) ? parsedTour.findingRevisions : [],
      },
      ...(row.context_fingerprint ? { contextFingerprint: String(row.context_fingerprint) } : {}),
      ...(row.context_manifest_json ? { contextManifest: JSON.parse(String(row.context_manifest_json)) as SessionContextManifest } : {}),
      ...(row.anchors_json ? { anchors: JSON.parse(String(row.anchors_json)) as TourEvidenceAnchor[] } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listDraftComments(sessionId: string): DraftReviewComment[] {
    this.requireSession(sessionId);
    return this.database.prepare(`
      SELECT * FROM draft_comments WHERE session_id = ? ORDER BY created_at, id
    `).all(sessionId).map(rowToDraftComment);
  }

  saveDraftComment(sessionId: string, comment: NewDraftReviewComment): DraftReviewComment {
    this.requireSession(sessionId);
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO draft_comments (
        id, session_id, stop_id, evidence_id, path, side, start_line, end_line,
        body, severity, fingerprint, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, sessionId, comment.stopId, comment.evidenceId, comment.path, comment.side,
      comment.startLine, comment.endLine, comment.body, comment.severity, comment.fingerprint,
      timestamp, timestamp,
    );
    return this.listDraftComments(sessionId).find((draft) => draft.id === id)!;
  }

  deleteDraftComment(sessionId: string, commentId: string): boolean {
    this.requireSession(sessionId);
    return this.database.prepare("DELETE FROM draft_comments WHERE id = ? AND session_id = ?")
      .run(commentId, sessionId).changes > 0;
  }

  getReviewDraft(sessionId: string): ReviewDraft | undefined {
    this.requireSession(sessionId);
    const row = this.database.prepare("SELECT * FROM review_drafts WHERE session_id = ?").get(sessionId);
    if (!row) return undefined;
    return {
      sessionId: String(row.session_id),
      body: String(row.body),
      event: String(row.event) as ReviewDraft["event"],
      updatedAt: String(row.updated_at),
    };
  }

  saveReviewDraft(sessionId: string, body: string, event: ReviewDraft["event"]): ReviewDraft {
    this.requireSession(sessionId);
    const updatedAt = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO review_drafts (session_id, body, event, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        body = excluded.body,
        event = excluded.event,
        updated_at = excluded.updated_at
    `).run(sessionId, body, event, updatedAt);
    return this.getReviewDraft(sessionId)!;
  }

  getSubmittedReview(sessionId: string, headSha: string): SubmittedReview | undefined {
    this.requireSession(sessionId);
    const row = this.database.prepare("SELECT * FROM submitted_reviews WHERE session_id = ? AND head_sha = ?")
      .get(sessionId, headSha);
    if (!row) return undefined;
    return {
      sessionId: String(row.session_id),
      headSha: String(row.head_sha),
      githubReviewId: Number(row.github_review_id),
      url: String(row.url),
      event: String(row.event) as ReviewDraft["event"],
      body: String(row.body),
      comments: JSON.parse(String(row.comments_json)) as DraftReviewComment[],
      submittedAt: String(row.submitted_at),
    };
  }

  saveSubmittedReview(
    sessionId: string,
    headSha: string,
    githubReviewId: number,
    url: string,
    draft: Pick<ReviewDraft, "body" | "event">,
    comments: DraftReviewComment[],
  ): SubmittedReview {
    this.requireSession(sessionId);
    const submittedAt = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO submitted_reviews (
        session_id, head_sha, github_review_id, url, event, body, comments_json, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, headSha, githubReviewId, url, draft.event, draft.body, JSON.stringify(comments), submittedAt);
    return this.getSubmittedReview(sessionId, headSha)!;
  }

  getReviewPublication(sessionId: string, headSha: string): ReviewPublicationAttempt | undefined {
    this.requireSession(sessionId);
    const row = this.database.prepare("SELECT * FROM review_publications WHERE session_id = ? AND head_sha = ?")
      .get(sessionId, headSha);
    if (!row) return undefined;
    return {
      sessionId: String(row.session_id),
      headSha: String(row.head_sha),
      state: String(row.state) as ReviewPublicationAttempt["state"],
      event: String(row.event) as ReviewDraft["event"],
      body: String(row.body),
      comments: JSON.parse(String(row.comments_json)) as DraftReviewComment[],
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
      ...(row.error ? { error: String(row.error) } : {}),
    };
  }

  beginReviewPublication(
    sessionId: string,
    headSha: string,
    draft: Pick<ReviewDraft, "body" | "event">,
    comments: DraftReviewComment[],
  ): ReviewPublicationAttempt {
    this.requireSession(sessionId);
    if (this.getSubmittedReview(sessionId, headSha)) throw new Error("A review has already been published for this pinned head.");
    const existing = this.getReviewPublication(sessionId, headSha);
    if (existing) {
      throw new Error(existing.state === "publishing"
        ? "A review publication is already in progress for this pinned head."
        : "A previous publication has an uncertain outcome. Verify GitHub before allowing a retry.");
    }
    const timestamp = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO review_publications (
        session_id, head_sha, state, event, body, comments_json, started_at, updated_at, error
      ) VALUES (?, ?, 'publishing', ?, ?, ?, ?, ?, NULL)
    `).run(sessionId, headSha, draft.event, draft.body, JSON.stringify(comments), timestamp, timestamp);
    return this.getReviewPublication(sessionId, headSha)!;
  }

  markReviewPublicationUncertain(sessionId: string, headSha: string, error: string): ReviewPublicationAttempt {
    this.requireSession(sessionId);
    this.database.prepare(`
      UPDATE review_publications SET state = 'uncertain', error = ?, updated_at = ?
      WHERE session_id = ? AND head_sha = ?
    `).run(error.slice(0, 2_000), this.now().toISOString(), sessionId, headSha);
    return this.getReviewPublication(sessionId, headSha)!;
  }

  clearUncertainReviewPublication(sessionId: string, headSha: string): boolean {
    this.requireSession(sessionId);
    return this.database.prepare(`
      DELETE FROM review_publications WHERE session_id = ? AND head_sha = ? AND state = 'uncertain'
    `).run(sessionId, headSha).changes > 0;
  }

  completeReviewPublication(
    sessionId: string,
    headSha: string,
    githubReviewId: number,
    url: string,
    draft: Pick<ReviewDraft, "body" | "event">,
    comments: DraftReviewComment[],
  ): SubmittedReview {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const submitted = this.saveSubmittedReview(sessionId, headSha, githubReviewId, url, draft, comments);
      this.database.prepare("DELETE FROM review_publications WHERE session_id = ? AND head_sha = ?").run(sessionId, headSha);
      this.database.exec("COMMIT");
      return submitted;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listInvestigationEntries(sessionId: string): InvestigationEntry[] {
    this.requireSession(sessionId);
    return this.database.prepare(`
      SELECT * FROM investigation_entries WHERE session_id = ? ORDER BY created_at, id
    `).all(sessionId).map(rowToInvestigationEntry);
  }

  createInvestigationEntry(
    sessionId: string,
    input: Pick<InvestigationEntry, "stopId" | "evidenceId" | "question" | "provider" | "model">,
  ): InvestigationEntry {
    this.requireSession(sessionId);
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO investigation_entries (
        id, session_id, stop_id, evidence_id, question, answer, provider, model, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '', ?, ?, 'streaming', ?, ?)
    `).run(id, sessionId, input.stopId, input.evidenceId, input.question, input.provider, input.model, timestamp, timestamp);
    return this.getInvestigationEntry(sessionId, id)!;
  }

  updateInvestigationEntry(
    sessionId: string,
    id: string,
    answer: string,
    status: InvestigationEntry["status"],
  ): InvestigationEntry | undefined {
    this.requireSession(sessionId);
    this.database.prepare(`
      UPDATE investigation_entries SET answer = ?, status = ?, updated_at = ?
      WHERE id = ? AND session_id = ?
    `).run(answer, status, this.now().toISOString(), id, sessionId);
    return this.getInvestigationEntry(sessionId, id);
  }

  private getInvestigationEntry(sessionId: string, id: string): InvestigationEntry | undefined {
    const row = this.database.prepare("SELECT * FROM investigation_entries WHERE id = ? AND session_id = ?").get(id, sessionId);
    return row ? rowToInvestigationEntry(row) : undefined;
  }

  close() {
    this.database.close();
  }

  private requireSession(id: string) {
    if (!this.database.prepare("SELECT 1 FROM review_sessions WHERE id = ?").get(id)) {
      throw new Error(`Review session ${id} does not exist.`);
    }
  }
}

export function defaultDatabasePath(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (environment.WINGDIFF_DATA_DIR) return path.join(environment.WINGDIFF_DATA_DIR, "wingdiff.sqlite3");
  if (environment.XDG_DATA_HOME) return path.join(environment.XDG_DATA_HOME, "wingdiff", "wingdiff.sqlite3");
  if (platform === "darwin") return path.join(homedir(), "Library", "Application Support", "wingdiff", "wingdiff.sqlite3");
  if (platform === "win32" && environment.LOCALAPPDATA) return path.join(environment.LOCALAPPDATA, "wingdiff", "wingdiff.sqlite3");
  return path.join(homedir(), ".local", "share", "wingdiff", "wingdiff.sqlite3");
}

function migrate(database: DatabaseSync) {
  let version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version > 15) throw new Error(`Wingdiff session database version ${version} is newer than this application supports.`);

  if (version === 0) database.exec(`
    BEGIN;
    CREATE TABLE review_sessions (
      id TEXT PRIMARY KEY,
      repository TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      canonical_url TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('acquiring', 'ready', 'failed')),
      metadata_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repository, pr_number, head_sha)
    );
    CREATE INDEX review_sessions_pr ON review_sessions(repository, pr_number, updated_at DESC);

    CREATE TABLE review_checkpoints (
      session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      reviewed_head_sha TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      coverage_json TEXT NOT NULL,
      finding_revisions_json TEXT NOT NULL,
      PRIMARY KEY(session_id, reviewed_head_sha)
    );

    CREATE TABLE review_progress (
      session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      stop_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('unseen', 'understood', 'flagged', 'skipped')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id, stop_id)
    );

    CREATE TABLE draft_comments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('LEFT', 'RIGHT')),
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      body TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    PRAGMA user_version = 1;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 1) database.exec(`
    BEGIN;
    CREATE TABLE generated_tours (
      session_id TEXT PRIMARY KEY REFERENCES review_sessions(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('codex', 'openai', 'anthropic')),
      model TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      tour_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 2;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 2) database.exec(`
    BEGIN;
    CREATE TABLE review_updates (
      session_id TEXT PRIMARY KEY REFERENCES review_sessions(id) ON DELETE CASCADE,
      baseline_session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      from_head_sha TEXT NOT NULL,
      to_head_sha TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    PRAGMA user_version = 3;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 3) database.exec(`
    BEGIN;
    ALTER TABLE generated_tours RENAME TO generated_tours_v3;
    CREATE TABLE generated_tours (
      session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('full', 'update')),
      provider TEXT NOT NULL CHECK (provider IN ('codex', 'openai', 'anthropic')),
      model TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      tour_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id, scope)
    );
    INSERT INTO generated_tours (
      session_id, scope, provider, model, reasoning_effort, base_sha, head_sha, tour_json, created_at, updated_at
    )
    SELECT t.session_id, 'full', t.provider, t.model, t.reasoning_effort, s.base_sha, t.head_sha,
           t.tour_json, t.created_at, t.updated_at
    FROM generated_tours_v3 t JOIN review_sessions s ON s.id = t.session_id;
    DROP TABLE generated_tours_v3;
    PRAGMA user_version = 4;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 4) database.exec(`
    BEGIN;
    ALTER TABLE review_checkpoints ADD COLUMN scope TEXT NOT NULL DEFAULT 'full'
      CHECK (scope IN ('full', 'update'));
    PRAGMA user_version = 5;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 5) database.exec(`
    BEGIN;
    ALTER TABLE draft_comments ADD COLUMN stop_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE draft_comments ADD COLUMN evidence_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE draft_comments ADD COLUMN severity TEXT NOT NULL DEFAULT 'low'
      CHECK (severity IN ('high', 'medium', 'low'));
    PRAGMA user_version = 6;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 6) database.exec(`
    BEGIN;
    CREATE TABLE review_drafts (
      session_id TEXT PRIMARY KEY REFERENCES review_sessions(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('COMMENT', 'APPROVE', 'REQUEST_CHANGES')),
      updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 7;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 7) database.exec(`
    BEGIN;
    CREATE TABLE submitted_reviews (
      session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      head_sha TEXT NOT NULL,
      github_review_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('COMMENT', 'APPROVE', 'REQUEST_CHANGES')),
      body TEXT NOT NULL,
      comments_json TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      PRIMARY KEY(session_id, head_sha)
    );
    PRAGMA user_version = 8;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 8) database.exec(`
    BEGIN;
    CREATE TABLE investigation_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      stop_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('codex', 'openai', 'anthropic')),
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('streaming', 'complete', 'error')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX investigation_entries_session ON investigation_entries(session_id, created_at);
    PRAGMA user_version = 9;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 9) database.exec(`
    BEGIN;
    ALTER TABLE review_progress RENAME TO review_progress_v9;
    CREATE TABLE review_progress (
      session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('full', 'update')),
      stop_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('unseen', 'understood', 'flagged', 'skipped')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id, scope, stop_id)
    );
    INSERT INTO review_progress (session_id, scope, stop_id, status, updated_at)
    SELECT session_id, 'full', stop_id, status, updated_at FROM review_progress_v9;
    DROP TABLE review_progress_v9;
    CREATE TABLE review_state (
      session_id TEXT PRIMARY KEY REFERENCES review_sessions(id) ON DELETE CASCADE,
      active_scope TEXT NOT NULL CHECK (active_scope IN ('full', 'update')),
      full_stop_id TEXT,
      update_stop_id TEXT,
      updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 10;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 10) database.exec(`
    BEGIN;
    ALTER TABLE review_checkpoints RENAME TO review_checkpoints_v10;
    CREATE TABLE review_checkpoints (
      session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      reviewed_head_sha TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('full', 'update')),
      coverage_json TEXT NOT NULL,
      finding_revisions_json TEXT NOT NULL,
      PRIMARY KEY(session_id, reviewed_head_sha, scope)
    );
    INSERT INTO review_checkpoints (
      session_id, reviewed_head_sha, completed_at, scope, coverage_json, finding_revisions_json
    ) SELECT session_id, reviewed_head_sha, completed_at, scope, coverage_json, finding_revisions_json
      FROM review_checkpoints_v10;
    DROP TABLE review_checkpoints_v10;
    PRAGMA user_version = 11;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 11) database.exec(`
    BEGIN;
    DELETE FROM generated_tours;
    CREATE TABLE context_settings (
      session_id TEXT PRIMARY KEY REFERENCES review_sessions(id) ON DELETE CASCADE,
      excluded_patterns_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    PRAGMA user_version = 12;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 12) database.exec(`
    BEGIN;
    CREATE TABLE review_publications (
      session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
      head_sha TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('publishing', 'uncertain')),
      event TEXT NOT NULL CHECK (event IN ('COMMENT', 'APPROVE', 'REQUEST_CHANGES')),
      body TEXT NOT NULL,
      comments_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error TEXT,
      PRIMARY KEY(session_id, head_sha)
    );
    PRAGMA user_version = 13;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 13) database.exec(`
    BEGIN;
    ALTER TABLE generated_tours ADD COLUMN context_fingerprint TEXT NOT NULL DEFAULT '';
    ALTER TABLE generated_tours ADD COLUMN context_manifest_json TEXT;
    ALTER TABLE generated_tours ADD COLUMN anchors_json TEXT;
    PRAGMA user_version = 14;
    COMMIT;
  `);

  version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version === 14) database.exec(`
    BEGIN;
    ALTER TABLE review_sessions ADD COLUMN repository_path TEXT;
    PRAGMA user_version = 15;
    COMMIT;
  `);
}

function rowToSession(row: Record<string, unknown>): ReviewSession {
  return {
    id: String(row.id),
    target: parsePullRequestTarget(String(row.canonical_url)),
    metadata: JSON.parse(String(row.metadata_json)) as PullRequestMetadata,
    evidence: JSON.parse(String(row.evidence_json)) as PullRequestEvidence,
    status: String(row.status) as SessionStatus,
    ...(typeof row.repository_path === "string" && row.repository_path ? { repositoryPath: row.repository_path } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToDraftComment(row: Record<string, unknown>): DraftReviewComment {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    stopId: String(row.stop_id),
    evidenceId: String(row.evidence_id),
    path: String(row.path),
    side: String(row.side) as DraftReviewComment["side"],
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    body: String(row.body),
    severity: String(row.severity) as DraftReviewComment["severity"],
    fingerprint: String(row.fingerprint),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToInvestigationEntry(row: Record<string, unknown>): InvestigationEntry {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    stopId: String(row.stop_id),
    evidenceId: String(row.evidence_id),
    question: String(row.question),
    answer: String(row.answer),
    provider: String(row.provider) as InvestigationEntry["provider"],
    model: String(row.model),
    status: String(row.status) as InvestigationEntry["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
