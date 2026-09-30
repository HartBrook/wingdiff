import type { AnswerStatus, Confidence, EvidenceBlock, ModelSelection, ProviderId, StopStatus, TourStop } from "./types";
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
  scope: "full" | "update";
  selection: ModelSelection;
  baseSha: string;
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
    findingRevisions: Array<{
      findingId: string;
      state: "still-applies" | "appears-addressed" | "recheck" | "superseded";
      summary: string;
      anchorIds: string[];
    }>;
  };
  anchors: TourEvidenceAnchor[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewCheckpoint {
  reviewedHeadSha: string;
  completedAt: string;
  scope: "full" | "update";
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

export interface StoredReviewUpdate {
  sessionId: string;
  baselineSessionId: string;
  fromHeadSha: string;
  toHeadSha: string;
  evidence: AcquiredReviewSession["evidence"];
  createdAt: string;
}

export interface SessionUpdateContext {
  update: StoredReviewUpdate;
  baselineCheckpoint: ReviewCheckpoint;
}

export interface StoredDraftReviewComment {
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

export interface StoredReviewDraft {
  sessionId: string;
  body: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  updatedAt: string;
}

export interface StoredReviewSubmission {
  sessionId: string;
  headSha: string;
  githubReviewId: number;
  url: string;
  event: StoredReviewDraft["event"];
  body: string;
  comments: StoredDraftReviewComment[];
  submittedAt: string;
}

export interface StoredInvestigationEntry {
  id: string;
  sessionId: string;
  stopId: string;
  evidenceId: string;
  question: string;
  answer: string;
  provider: ProviderId;
  model: string;
  status: AnswerStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewProgressSnapshot {
  activeScope: "full" | "update" | null;
  activeStopIds: Record<"full" | "update", string | null>;
  scopes: Record<"full" | "update", Record<string, StopStatus>>;
}

export interface SessionContextManifest {
  scope: "full" | "update";
  baseSha: string;
  headSha: string;
  excludedPatterns: string[];
  files: Array<{
    path: string;
    included: boolean;
    matchedPattern?: string;
    classifications: Array<"sensitive" | "generated" | "vendor">;
    additions: number;
    deletions: number;
    characters: number;
  }>;
  instructions: Array<{ path: string; content: string; characters: number; truncated: boolean }>;
  includedFiles: number;
  excludedFiles: number;
  characters: number;
  warnings: string[];
  ready: boolean;
  promptPreview: string;
  fingerprint: string;
}

export interface ReviewRefreshResult {
  status: "current" | "updated";
  session: AcquiredReviewSession;
  update?: StoredReviewUpdate;
}

export async function createReviewSession(input: string): Promise<AcquiredReviewSession> {
  return sessionRequest("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
}

export async function fetchReviewSession(id: string, signal?: AbortSignal): Promise<AcquiredReviewSession> {
  return sessionRequest(`/api/sessions/${encodeURIComponent(id)}`, { signal });
}

export async function fetchSessionTour(id: string, scope: "full" | "update" = "full", signal?: AbortSignal): Promise<GeneratedSessionTour | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/tour?scope=${scope}`, { signal });
  if (response.status === 404) return null;
  const body = await response.json() as { generated?: GeneratedSessionTour; error?: string };
  if (!response.ok || !body.generated) throw new Error(body.error ?? "Wingdiff could not load this guided tour.");
  return body.generated;
}

export async function generateSessionTour(
  id: string,
  selection: ModelSelection,
  scope: "full" | "update" = "full",
  signal?: AbortSignal,
): Promise<GeneratedSessionTour> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/tour`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selection, scope }),
    signal,
  });
  const body = await response.json() as { generated?: GeneratedSessionTour; error?: string };
  if (!response.ok || !body.generated) throw new Error(body.error ?? "Wingdiff could not generate this guided tour.");
  return body.generated;
}

export async function fetchSessionContext(
  id: string,
  scope: "full" | "update",
  signal?: AbortSignal,
): Promise<SessionContextManifest> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/context?scope=${scope}`, { signal });
  const body = await response.json() as { manifest?: SessionContextManifest; error?: string };
  if (!response.ok || !body.manifest) throw new Error(body.error ?? "Wingdiff could not prepare the model context.");
  return body.manifest;
}

export async function saveSessionContext(
  id: string,
  scope: "full" | "update",
  excludedPatterns: string[],
): Promise<SessionContextManifest> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/context`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, excludedPatterns }),
  });
  const body = await response.json() as { manifest?: SessionContextManifest; error?: string };
  if (!response.ok || !body.manifest) throw new Error(body.error ?? "Wingdiff could not save model-context settings.");
  return body.manifest;
}

export async function fetchReviewCheckpoint(id: string, scope: "full" | "update", signal?: AbortSignal): Promise<ReviewCheckpoint | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/checkpoint?scope=${scope}`, { signal });
  const body = await response.json() as { checkpoint?: ReviewCheckpoint | null; error?: string };
  if (!response.ok) throw new Error(body.error ?? "Wingdiff could not load this review checkpoint.");
  return body.checkpoint ?? null;
}

export async function fetchReviewProgress(id: string, signal?: AbortSignal): Promise<ReviewProgressSnapshot> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/progress`, { signal });
  const body = await response.json() as { progress?: ReviewProgressSnapshot; error?: string };
  if (!response.ok || !body.progress) throw new Error(body.error ?? "Wingdiff could not load review progress.");
  return body.progress;
}

export async function saveReviewProgress(
  id: string,
  scope: "full" | "update",
  activeStopId: string,
  change?: { stopId: string; status: StopStatus },
): Promise<ReviewProgressSnapshot> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/progress`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, activeStopId, change }),
  });
  const body = await response.json() as { progress?: ReviewProgressSnapshot; error?: string };
  if (!response.ok || !body.progress) throw new Error(body.error ?? "Wingdiff could not save review progress.");
  return body.progress;
}

export async function completeReviewCheckpoint(
  id: string,
  scope: "full" | "update",
  coverage: Record<string, string>,
): Promise<ReviewCheckpoint> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/checkpoint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, coverage }),
  });
  const body = await response.json() as { checkpoint?: ReviewCheckpoint; error?: string };
  if (!response.ok || !body.checkpoint) throw new Error(body.error ?? "Wingdiff could not complete this review.");
  return body.checkpoint;
}

export async function fetchSessionUpdate(id: string, signal?: AbortSignal): Promise<SessionUpdateContext | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/update`, { signal });
  const body = await response.json() as { update?: StoredReviewUpdate | null; baselineCheckpoint?: ReviewCheckpoint | null; error?: string };
  if (!response.ok) throw new Error(body.error ?? "Wingdiff could not load update evidence.");
  return body.update && body.baselineCheckpoint ? { update: body.update, baselineCheckpoint: body.baselineCheckpoint } : null;
}

export async function fetchDraftComments(id: string, signal?: AbortSignal): Promise<StoredDraftReviewComment[]> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/comments`, { signal });
  const body = await response.json() as { comments?: StoredDraftReviewComment[]; error?: string };
  if (!response.ok || !body.comments) throw new Error(body.error ?? "Wingdiff could not load draft comments.");
  return body.comments;
}

export async function createDraftComment(
  id: string,
  comment: Omit<StoredDraftReviewComment, "id" | "sessionId" | "createdAt" | "updatedAt">,
): Promise<StoredDraftReviewComment> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(comment),
  });
  const body = await response.json() as { comment?: StoredDraftReviewComment; error?: string };
  if (!response.ok || !body.comment) throw new Error(body.error ?? "Wingdiff could not stage this comment.");
  return body.comment;
}

export async function deleteDraftComment(id: string, commentId: string): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" });
  if (response.ok) return;
  const body = await response.json() as { error?: string };
  throw new Error(body.error ?? "Wingdiff could not remove this draft comment.");
}

export async function fetchInvestigationEntries(id: string, signal?: AbortSignal): Promise<StoredInvestigationEntry[]> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/investigations`, { signal });
  const body = await response.json() as { entries?: StoredInvestigationEntry[]; error?: string };
  if (!response.ok || !body.entries) throw new Error(body.error ?? "Wingdiff could not load the investigation notebook.");
  return body.entries;
}

export async function createInvestigationEntry(
  id: string,
  input: Pick<StoredInvestigationEntry, "stopId" | "evidenceId" | "question" | "provider" | "model">,
): Promise<StoredInvestigationEntry> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/investigations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json() as { entry?: StoredInvestigationEntry; error?: string };
  if (!response.ok || !body.entry) throw new Error(body.error ?? "Wingdiff could not start this investigation.");
  return body.entry;
}

export async function updateInvestigationEntry(
  id: string,
  entryId: string,
  answer: string,
  status: "complete" | "error",
): Promise<StoredInvestigationEntry> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/investigations/${encodeURIComponent(entryId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer, status }),
  });
  const body = await response.json() as { entry?: StoredInvestigationEntry; error?: string };
  if (!response.ok || !body.entry) throw new Error(body.error ?? "Wingdiff could not save this investigation.");
  return body.entry;
}

export async function fetchReviewDraft(id: string, signal?: AbortSignal): Promise<StoredReviewDraft | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/review-draft`, { signal });
  const body = await response.json() as { draft?: StoredReviewDraft | null; error?: string };
  if (!response.ok) throw new Error(body.error ?? "Wingdiff could not load this review draft.");
  return body.draft ?? null;
}

export async function saveReviewDraft(
  id: string,
  body: string,
  event: StoredReviewDraft["event"],
): Promise<StoredReviewDraft> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/review-draft`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, event }),
  });
  const result = await response.json() as { draft?: StoredReviewDraft; error?: string };
  if (!response.ok || !result.draft) throw new Error(result.error ?? "Wingdiff could not save this review draft.");
  return result.draft;
}

export async function fetchReviewSubmission(id: string, signal?: AbortSignal): Promise<StoredReviewSubmission | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/review-submission`, { signal });
  const body = await response.json() as { submission?: StoredReviewSubmission | null; error?: string };
  if (!response.ok) throw new Error(body.error ?? "Wingdiff could not load the submitted review.");
  return body.submission ?? null;
}

export async function publishReview(
  id: string,
  body: string,
  event: StoredReviewDraft["event"],
  scope: "full" | "update",
  acknowledgeApprovalRisks = false,
): Promise<StoredReviewSubmission> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/review-submission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, event, scope, acknowledgeApprovalRisks }),
  });
  const result = await response.json() as { submission?: StoredReviewSubmission; error?: string };
  if (!response.ok || !result.submission) throw new Error(result.error ?? "Wingdiff could not publish this review.");
  return result.submission;
}

export async function refreshReviewSession(id: string): Promise<ReviewRefreshResult> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/refresh`, { method: "POST" });
  const body = await response.json() as Partial<ReviewRefreshResult> & { error?: string };
  if (!response.ok || !body.status || !body.session) throw new Error(body.error ?? "Wingdiff could not check for updates.");
  return body as ReviewRefreshResult;
}

export function evidenceBlocks(session: AcquiredReviewSession): EvidenceBlock[] {
  return evidenceBlocksFor(session.evidence);
}

export function evidenceBlocksFor(evidence: AcquiredReviewSession["evidence"]): EvidenceBlock[] {
  return evidence.files.map((file, fileIndex) => {
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
          fingerprint: line.fingerprint,
          ...(line.oldLine === undefined ? {} : { oldLine: line.oldLine }),
          ...(line.newLine === undefined ? {} : { newLine: line.newLine }),
        })),
      ]) : [{ kind: "header" as const, content: file.status === "binary" ? "Binary file changed" : "File metadata changed" }],
    };
  });
}

export function generatedTourStops(
  session: AcquiredReviewSession,
  generated: GeneratedSessionTour,
  evidence: AcquiredReviewSession["evidence"] = session.evidence,
): TourStop[] {
  const anchors = new Map(generated.anchors.map((anchor) => [anchor.id, anchor]));
  const blocks = new Map(evidenceBlocksFor(evidence).map((block) => [block.path, block]));

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
      return [focusedEvidenceBlock(block, stopAnchors.filter((anchor) => anchor.path === path))];
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

const FOCUSED_CONTEXT_LINES = 5;

function focusedEvidenceBlock(block: EvidenceBlock, anchors: TourEvidenceAnchor[]): EvidenceBlock {
  const lineAnchors = anchors.filter((anchor) => anchor.kind !== "file");
  if (!lineAnchors.length) return block;

  const lines: EvidenceBlock["lines"] = [];
  let segmentStart = 0;
  while (segmentStart < block.lines.length) {
    const header = block.lines[segmentStart]?.kind === "header" ? block.lines[segmentStart] : undefined;
    const contentStart = header ? segmentStart + 1 : segmentStart;
    let segmentEnd = contentStart;
    while (segmentEnd < block.lines.length && block.lines[segmentEnd]?.kind !== "header") segmentEnd += 1;

    const anchorIndexes = block.lines.slice(contentStart, segmentEnd).flatMap((line, offset) => (
      lineAnchors.some((anchor) => anchorMatchesLine(anchor, line)) ? [contentStart + offset] : []
    ));
    const ranges = coalesceRanges(anchorIndexes.map((index) => ({
      start: Math.max(contentStart, index - FOCUSED_CONTEXT_LINES),
      end: Math.min(segmentEnd, index + FOCUSED_CONTEXT_LINES + 1),
    })));
    for (const range of ranges) {
      if (header) lines.push(header);
      lines.push(...block.lines.slice(range.start, range.end).map((line) => ({
        ...line,
        emphasized: lineAnchors.some((anchor) => anchorMatchesLine(anchor, line)),
      })));
    }
    segmentStart = segmentEnd;
  }

  if (!lines.length) return block;
  const numberedLines = lines.flatMap((line) => [line.oldLine, line.newLine]).filter((line): line is number => line !== undefined);
  return {
    ...block,
    startLine: numberedLines.length ? Math.min(...numberedLines) : block.startLine,
    endLine: numberedLines.length ? Math.max(...numberedLines) : block.endLine,
    lines,
  };
}

function anchorMatchesLine(anchor: TourEvidenceAnchor, line: EvidenceBlock["lines"][number]): boolean {
  return anchor.oldLine === line.oldLine && anchor.newLine === line.newLine && anchor.content === line.content;
}

function coalesceRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const result: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

export function revisionStopIndex(generated: GeneratedSessionTour, revisionAnchorIds: string[]): number {
  const anchors = new Map(generated.anchors.map((anchor) => [anchor.id, anchor]));
  const revisionPaths = new Set(revisionAnchorIds.flatMap((id) => {
    const path = anchors.get(id)?.path;
    return path ? [path] : [];
  }));

  return generated.tour.stops.findIndex((stop) => {
    const stopAnchorIds = [
      ...stop.anchorIds,
      ...stop.claims.flatMap((claim) => claim.anchorIds),
      ...(stop.finding?.anchorIds ?? []),
    ];
    return stopAnchorIds.some((id) => revisionAnchorIds.includes(id) || revisionPaths.has(anchors.get(id)?.path ?? ""));
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
