import type { Confidence, EvidenceBlock, ModelSelection, TourStop } from "./types";
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

export interface TourEvidenceAnchor {
  id: string;
  path: string;
  kind: "file" | SessionEvidenceLine["kind"];
  content?: string;
  oldLine?: number;
  newLine?: number;
}

export interface GeneratedSessionTour {
  sessionId: string;
  selection: ModelSelection;
  headSha: string;
  tour: {
    summary: string;
    stops: Array<{
      id: string;
      title: string;
      summary: string;
      purpose: string;
      anchorIds: string[];
      claims: Array<{
        text: string;
        kind: "fact" | "inference" | "unknown";
        confidence: Confidence;
        anchorIds: string[];
      }>;
      prompts: string[];
      finding?: {
        title: string;
        body: string;
        severity: "high" | "medium" | "low";
        category: string;
        anchorIds: string[];
        suggestedComment: string;
      };
    }>;
  };
  anchors: TourEvidenceAnchor[];
  createdAt: string;
  updatedAt: string;
}

export async function createReviewSession(input: string): Promise<AcquiredReviewSession> {
  return sessionRequest("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
}

export async function fetchReviewSession(id: string, signal?: AbortSignal): Promise<AcquiredReviewSession> {
  return sessionRequest(`/api/sessions/${encodeURIComponent(id)}`, { signal });
}

export async function fetchSessionTour(id: string, signal?: AbortSignal): Promise<GeneratedSessionTour | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/tour`, { signal });
  if (response.status === 404) return null;
  const body = await response.json() as { generated?: GeneratedSessionTour; error?: string };
  if (!response.ok || !body.generated) throw new Error(body.error ?? "Wingdiff could not load this guided tour.");
  return body.generated;
}

export async function generateSessionTour(
  id: string,
  selection: ModelSelection,
  signal?: AbortSignal,
): Promise<GeneratedSessionTour> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/tour`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selection }),
    signal,
  });
  const body = await response.json() as { generated?: GeneratedSessionTour; error?: string };
  if (!response.ok || !body.generated) throw new Error(body.error ?? "Wingdiff could not generate this guided tour.");
  return body.generated;
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

export function generatedTourStops(session: AcquiredReviewSession, generated: GeneratedSessionTour): TourStop[] {
  const anchors = new Map(generated.anchors.map((anchor) => [anchor.id, anchor]));
  const blocks = new Map(evidenceBlocks(session).map((block) => [block.path, block]));

  return generated.tour.stops.map((stop, index) => {
    const allAnchorIds = [
      ...stop.anchorIds,
      ...stop.claims.flatMap((claim) => claim.anchorIds),
      ...(stop.finding?.anchorIds ?? []),
    ];
    const stopAnchors = allAnchorIds.map((id) => anchors.get(id)).filter((anchor): anchor is TourEvidenceAnchor => Boolean(anchor));
    const paths = [...new Set(stopAnchors.map((anchor) => anchor.path))];
    const evidence = paths.flatMap((path) => {
      const block = blocks.get(path);
      if (!block) return [];
      return [{
        ...block,
        lines: block.lines.map((line) => ({
          ...line,
          emphasized: stopAnchors.some((anchor) => anchor.path === path && anchor.kind !== "file" && (
            anchor.oldLine === line.oldLine && anchor.newLine === line.newLine && anchor.content === line.content
          )),
        })),
      }];
    });
    const fallback = evidence[0] ?? [...blocks.values()][0]!;
    const evidenceFor = (anchorIds: string[]) => [...new Set(anchorIds.flatMap((id) => {
      const path = anchors.get(id)?.path;
      const block = path ? evidence.find((candidate) => candidate.path === path) : undefined;
      return block ? [block.id] : [];
    }))];
    const findingEvidence = stop.finding ? evidenceFor(stop.finding.anchorIds)[0] ?? fallback.id : fallback.id;
    const lineCount = evidence.reduce((total, block) => total + block.lines.filter((line) => line.kind !== "header").length, 0);

    return {
      id: stop.id,
      order: index + 1,
      eyebrow: stop.finding ? `${stop.finding.severity} finding` : "Code change",
      title: stop.title,
      summary: stop.summary,
      why: stop.purpose,
      confidence: overallConfidence(stop.claims.map((claim) => claim.confidence)),
      minutes: Math.max(1, Math.ceil(lineCount / 40)),
      evidence: evidence.length ? evidence : [fallback],
      claims: stop.claims.map((claim, claimIndex) => ({
        id: `${stop.id}-claim-${claimIndex + 1}`,
        text: claim.text,
        kind: claim.kind,
        confidence: claim.confidence,
        evidenceIds: evidenceFor(claim.anchorIds),
      })),
      prompts: stop.prompts,
      topologyNodes: [],
      ...(stop.finding ? {
        finding: {
          id: `${stop.id}-finding`,
          title: stop.finding.title,
          body: stop.finding.body,
          severity: stop.finding.severity,
          category: stop.finding.category,
          evidenceId: findingEvidence,
          suggestedComment: stop.finding.suggestedComment,
        },
      } : {}),
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

function overallConfidence(confidences: Confidence[]): Confidence {
  if (confidences.includes("low")) return "low";
  if (confidences.includes("medium")) return "medium";
  return "high";
}
