import type { EvidenceBlock } from "./types";
import type { PullRequestTarget } from "./launcher";

export interface SessionEvidenceLine {
  kind: "context" | "addition" | "deletion";
  content: string;
  oldLine?: number;
  newLine?: number;
  fingerprint: string;
}

export interface SessionChangedFile {
  oldPath?: string;
  path: string;
  status: "added" | "deleted" | "modified" | "renamed" | "binary";
  additions: number;
  deletions: number;
  hunks: Array<{
    header: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: SessionEvidenceLine[];
  }>;
}

export interface AcquiredReviewSession {
  id: string;
  target: PullRequestTarget;
  metadata: {
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
  };
  evidence: {
    baseSha: string;
    headSha: string;
    additions: number;
    deletions: number;
    files: SessionChangedFile[];
  };
  status: "acquiring" | "ready" | "failed";
  createdAt: string;
  updatedAt: string;
}

export async function createReviewSession(input: string): Promise<AcquiredReviewSession> {
  return sessionRequest("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
}

export async function fetchReviewSession(id: string, signal?: AbortSignal): Promise<AcquiredReviewSession> {
  return sessionRequest(`/api/sessions/${encodeURIComponent(id)}`, { signal });
}

export function evidenceBlocks(session: AcquiredReviewSession): EvidenceBlock[] {
  return session.evidence.files.map((file, fileIndex) => {
    const numberedLines = file.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => [line.oldLine, line.newLine]))
      .filter((line): line is number => line !== undefined);
    return {
      id: `session-${fileIndex}-${file.path}`,
      path: file.path,
      label: `${statusLabel(file.status)} · +${file.additions} −${file.deletions}`,
      language: languageFor(file.path),
      startLine: numberedLines.length ? Math.min(...numberedLines) : 1,
      endLine: numberedLines.length ? Math.max(...numberedLines) : 1,
      lines: file.hunks.length ? file.hunks.flatMap((hunk) => [
        { kind: "header" as const, content: hunk.header },
        ...hunk.lines.map((line) => ({
          kind: line.kind,
          content: line.content,
          ...(line.oldLine === undefined ? {} : { oldLine: line.oldLine }),
          ...(line.newLine === undefined ? {} : { newLine: line.newLine }),
        })),
      ]) : [{ kind: "header" as const, content: file.status === "binary" ? "Binary file changed" : "File metadata changed" }],
    };
  });
}

async function sessionRequest(url: string, init?: RequestInit): Promise<AcquiredReviewSession> {
  const response = await fetch(url, init);
  const body = await response.json() as { session?: AcquiredReviewSession; error?: string };
  if (!response.ok || !body.session) throw new Error(body.error ?? "Wingdiff could not open this review session.");
  return body.session;
}

function statusLabel(status: SessionChangedFile["status"]): string {
  return status[0]!.toUpperCase() + status.slice(1);
}

function languageFor(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const languages: Record<string, string> = {
    c: "C", cc: "C++", cpp: "C++", css: "CSS", go: "Go", html: "HTML", java: "Java",
    js: "JavaScript", json: "JSON", jsx: "JavaScript", md: "Markdown", py: "Python", rb: "Ruby",
    rs: "Rust", sh: "Shell", sql: "SQL", ts: "TypeScript", tsx: "TypeScript", yaml: "YAML", yml: "YAML",
  };
  return extension ? languages[extension] ?? extension.toUpperCase() : "Text";
}
