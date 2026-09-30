import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { filteredEvidenceForSession } from "./context.js";
import type { EvidenceLine } from "./diff.js";
import type { InvestigationContext } from "./providers/types.js";
import type { ReviewSession, SessionStore, TourScope } from "./sessions.js";
import { getSessionTour } from "./tourService.js";
import type { TourEvidenceAnchor } from "./tour.js";

const execFile = promisify(execFileCallback);
const SOURCE_RADIUS = 20;
const MAX_RELATED_MATCHES = 30;
const MAX_RELATED_PATHS = 6;
const MAX_SYMBOLS = 3;
const IGNORED_SYMBOLS = new Set([
  "async", "await", "class", "const", "else", "export", "false", "function", "import", "null",
  "return", "throw", "true", "undefined", "from", "this", "type", "interface", "string", "number",
]);

export type InvestigationGitRunner = (arguments_: string[], cwd: string) => Promise<string>;

export async function buildSessionInvestigationContext(
  session: ReviewSession,
  store: SessionStore,
  scope: TourScope,
  stopId: string,
  question: string,
  repositoryRoot: string,
  runGit: InvestigationGitRunner = defaultGitRunner,
): Promise<InvestigationContext> {
  const generated = getSessionTour(session, store, scope);
  if (!generated) throw new Error("Generate this guided review before investigating it.");
  const stop = generated.tour.stops.find((candidate) => candidate.id === stopId);
  if (!stop) throw new Error("The selected review stop is not part of the current guided review.");

  const evidence = filteredEvidenceForSession(session, store, scope);
  const anchors = new Map(generated.anchors.map((anchor) => [anchor.id, anchor]));
  const anchorIds = [
    ...stop.anchorIds,
    ...stop.claims.flatMap((claim) => claim.anchorIds),
    ...(stop.finding?.anchorIds ?? []),
  ];
  const stopAnchors = [...new Set(anchorIds)].flatMap((id) => {
    const anchor = anchors.get(id);
    return anchor ? [anchor] : [];
  });

  const diffEvidence = evidence.files.flatMap((file) => {
    const fileAnchors = stopAnchors.filter((anchor) => anchor.path === file.path);
    if (!fileAnchors.length) return [];
    const lineAnchors = fileAnchors.filter((anchor) => anchor.kind !== "file");
    const matchingHunks = file.hunks.filter((hunk) => !lineAnchors.length || hunk.lines.some((line) => (
      lineAnchors.some((anchor) => anchorMatches(anchor, line))
    )));
    const lines = matchingHunks.flatMap((hunk) => hunk.lines).slice(0, 600);
    if (!lines.length) return [];
    return [{
      path: file.path,
      revision: "diff" as const,
      ...lineRange(lines),
      lines,
    }];
  });

  const sourceEvidence = await sourceWindows(evidence, stopAnchors, repositoryRoot, runGit);
  const relatedEvidence = await relatedReferences(evidence.headSha, stopAnchors, repositoryRoot, runGit);
  return {
    question,
    stop: {
      title: stop.title,
      summary: stop.summary,
      why: stop.purpose,
      claims: stop.claims.map(({ text, kind, confidence }) => ({ text, kind, confidence })),
      evidence: [...diffEvidence, ...sourceEvidence, ...relatedEvidence],
    },
  };
}

async function sourceWindows(
  evidence: ReturnType<typeof filteredEvidenceForSession>,
  anchors: TourEvidenceAnchor[],
  repositoryRoot: string,
  runGit: InvestigationGitRunner,
): Promise<InvestigationContext["stop"]["evidence"]> {
  const result: InvestigationContext["stop"]["evidence"] = [];
  for (const file of evidence.files) {
    const fileAnchors = anchors.filter((anchor) => anchor.path === file.path && anchor.kind !== "file");
    if (!fileAnchors.length) continue;
    const relevantHunkLines = file.hunks.filter((hunk) => hunk.lines.some((line) => (
      fileAnchors.some((anchor) => anchorMatches(anchor, line))
    ))).flatMap((hunk) => hunk.lines);
    const revisions = [
      {
        revision: "head" as const,
        sha: evidence.headSha,
        path: file.path,
        lines: [...new Set(relevantHunkLines.flatMap((line) => line.newLine === undefined ? [] : [line.newLine]))],
      },
      {
        revision: "base" as const,
        sha: evidence.baseSha,
        path: file.oldPath ?? file.path,
        lines: [...new Set(relevantHunkLines.flatMap((line) => line.oldLine === undefined ? [] : [line.oldLine]))],
      },
    ];
    for (const revision of revisions) {
      if (!revision.lines.length) continue;
      const content = await readBlob(revision.sha, revision.path, repositoryRoot, runGit);
      if (!content) continue;
      const sourceLines = content.split(/\r?\n/);
      for (const range of coalesceRanges(revision.lines.map((line) => ({
        start: Math.max(1, line - SOURCE_RADIUS),
        end: Math.min(sourceLines.length, line + SOURCE_RADIUS),
      })))) {
        result.push({
          path: revision.path,
          revision: revision.revision,
          startLine: range.start,
          endLine: range.end,
          lines: sourceLines.slice(range.start - 1, range.end).map((content, index) => ({
            kind: "source",
            content,
            ...(revision.revision === "head" ? { newLine: range.start + index } : { oldLine: range.start + index }),
          })),
        });
      }
    }
  }
  return result.slice(0, 12);
}

async function relatedReferences(
  headSha: string,
  anchors: TourEvidenceAnchor[],
  repositoryRoot: string,
  runGit: InvestigationGitRunner,
): Promise<InvestigationContext["stop"]["evidence"]> {
  const symbols = symbolsFor(anchors);
  if (!symbols.length) return [];
  let output: string;
  try {
    output = await runGit([
      "grep", "-n", "-I", "-F",
      ...symbols.flatMap((symbol) => ["-e", symbol]),
      headSha,
      "--",
    ], repositoryRoot);
  } catch {
    return [];
  }

  const matches = output.split(/\r?\n/).flatMap((line) => {
    const value = line.startsWith(`${headSha}:`) ? line.slice(headSha.length + 1) : line;
    const match = /^(.*):(\d+):(.*)$/.exec(value);
    return match ? [{ path: match[1]!, line: Number(match[2]), content: match[3]! }] : [];
  }).slice(0, MAX_RELATED_MATCHES);
  const grouped = new Map<string, typeof matches>();
  for (const match of matches) {
    if (!grouped.has(match.path) && grouped.size >= MAX_RELATED_PATHS) continue;
    grouped.set(match.path, [...(grouped.get(match.path) ?? []), match]);
  }
  return [...grouped.entries()].map(([path, pathMatches]) => ({
    path,
    revision: "related" as const,
    startLine: Math.min(...pathMatches.map((match) => match.line)),
    endLine: Math.max(...pathMatches.map((match) => match.line)),
    lines: pathMatches.map((match) => ({ kind: "reference", newLine: match.line, content: match.content })),
  }));
}

function symbolsFor(anchors: TourEvidenceAnchor[]): string[] {
  const counts = new Map<string, number>();
  for (const anchor of anchors) {
    for (const symbol of anchor.content?.match(/[A-Za-z_$][\w$]{3,}/g) ?? []) {
      if (IGNORED_SYMBOLS.has(symbol) || /^[A-Z_]+$/.test(symbol)) continue;
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
  }
  return [...counts].sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
    .slice(0, MAX_SYMBOLS)
    .map(([symbol]) => symbol);
}

function anchorMatches(anchor: TourEvidenceAnchor, line: EvidenceLine): boolean {
  return anchor.oldLine === line.oldLine && anchor.newLine === line.newLine && anchor.content === line.content;
}

function lineRange(lines: EvidenceLine[]) {
  const numbers = lines.flatMap((line) => [line.oldLine, line.newLine]).filter((line): line is number => line !== undefined);
  return { startLine: numbers.length ? Math.min(...numbers) : 1, endLine: numbers.length ? Math.max(...numbers) : 1 };
}

function coalesceRanges(ranges: Array<{ start: number; end: number }>) {
  const result: Array<{ start: number; end: number }> = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

async function readBlob(sha: string, filePath: string, cwd: string, runGit: InvestigationGitRunner): Promise<string | undefined> {
  try {
    return await runGit(["show", `${sha}:${filePath}`], cwd);
  } catch {
    return undefined;
  }
}

async function defaultGitRunner(arguments_: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", arguments_, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && Number(error.code) === 1) return "";
    throw error;
  }
}
