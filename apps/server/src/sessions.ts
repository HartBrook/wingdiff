import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PullRequestEvidence } from "./diff.js";
import type { PullRequestMetadata } from "./github.js";
import { parsePullRequestTarget, type PullRequestTarget } from "./targets.js";

export type SessionStatus = "acquiring" | "ready" | "failed";

export interface ReviewSession {
  id: string;
  target: PullRequestTarget;
  metadata: PullRequestMetadata;
  evidence: PullRequestEvidence;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewCheckpoint {
  reviewedHeadSha: string;
  completedAt: string;
  coverage: Record<string, string>;
  findingRevisions: unknown[];
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

export class SessionStore {
  readonly database: DatabaseSync;

  constructor(databasePath = defaultDatabasePath(), private readonly now: () => Date = () => new Date()) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    migrate(this.database);
  }

  upsertReadySession(target: PullRequestTarget, metadata: PullRequestMetadata, evidence: PullRequestEvidence): ReviewSession {
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
        status, metadata_json, evidence_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)
      ON CONFLICT(repository, pr_number, head_sha) DO UPDATE SET
        canonical_url = excluded.canonical_url,
        base_sha = excluded.base_sha,
        title = excluded.title,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        evidence_json = excluded.evidence_json,
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

  saveCheckpoint(sessionId: string, checkpoint: ReviewCheckpoint) {
    this.requireSession(sessionId);
    this.database.prepare(`
      INSERT INTO review_checkpoints (
        session_id, reviewed_head_sha, completed_at, coverage_json, finding_revisions_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, reviewed_head_sha) DO UPDATE SET
        completed_at = excluded.completed_at,
        coverage_json = excluded.coverage_json,
        finding_revisions_json = excluded.finding_revisions_json
    `).run(
      sessionId,
      checkpoint.reviewedHeadSha,
      checkpoint.completedAt,
      JSON.stringify(checkpoint.coverage),
      JSON.stringify(checkpoint.findingRevisions),
    );
  }

  latestCheckpoint(sessionId: string): ReviewCheckpoint | undefined {
    const row = this.database.prepare(`
      SELECT reviewed_head_sha, completed_at, coverage_json, finding_revisions_json
      FROM review_checkpoints WHERE session_id = ? ORDER BY completed_at DESC LIMIT 1
    `).get(sessionId);
    if (!row) return undefined;
    return {
      reviewedHeadSha: String(row.reviewed_head_sha),
      completedAt: String(row.completed_at),
      coverage: JSON.parse(String(row.coverage_json)) as Record<string, string>,
      findingRevisions: JSON.parse(String(row.finding_revisions_json)) as unknown[],
    };
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
  const version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version > 1) throw new Error(`Wingdiff session database version ${version} is newer than this application supports.`);
  if (version === 1) return;

  database.exec(`
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
}

function rowToSession(row: Record<string, unknown>): ReviewSession {
  return {
    id: String(row.id),
    target: parsePullRequestTarget(String(row.canonical_url)),
    metadata: JSON.parse(String(row.metadata_json)) as PullRequestMetadata,
    evidence: JSON.parse(String(row.evidence_json)) as PullRequestEvidence,
    status: String(row.status) as SessionStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
