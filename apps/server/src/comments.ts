import type { PullRequestEvidence, EvidenceLine } from "./diff.js";
import type { NewDraftReviewComment } from "./sessions.js";

export function validateDraftComment(input: unknown, evidence: PullRequestEvidence): NewDraftReviewComment {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Draft comment is required.");
  const value = input as Record<string, unknown>;
  const stopId = text(value.stopId, "Review stop", 128);
  const evidenceId = text(value.evidenceId, "Evidence id", 600);
  const path = text(value.path, "Comment path", 1_000);
  const body = text(value.body, "Comment body", 65_536);
  const fingerprint = text(value.fingerprint, "Comment fingerprint", 128);
  const side = value.side;
  const severity = value.severity;
  const startLine = positiveInteger(value.startLine, "Comment start line");
  const endLine = positiveInteger(value.endLine, "Comment end line");

  if (side !== "LEFT" && side !== "RIGHT") throw new Error("Comment side must be LEFT or RIGHT.");
  if (severity !== "high" && severity !== "medium" && severity !== "low") throw new Error("Comment severity is invalid.");
  if (endLine < startLine) throw new Error("Comment line range is reversed.");

  const file = evidence.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Comment path is not part of the pinned diff: ${path}`);
  const hunk = file.hunks.find((candidate) => {
    const coordinates = candidate.lines.flatMap((line) => {
      const number = lineNumber(line, side);
      return number === undefined ? [] : [number];
    });
    return coordinates.includes(startLine) && coordinates.includes(endLine);
  });
  if (!hunk) throw new Error("Comment range is not contained in one pinned diff hunk.");
  const anchor = hunk.lines.find((line) => lineNumber(line, side) === endLine);
  if (!anchor || anchor.fingerprint !== fingerprint) throw new Error("Comment anchor no longer matches the pinned diff.");

  return { stopId, evidenceId, path, side, startLine, endLine, body, severity, fingerprint };
}

function lineNumber(line: EvidenceLine, side: "LEFT" | "RIGHT") {
  return side === "RIGHT" ? line.newLine : line.oldLine;
}

function text(input: unknown, label: string, maximum: number) {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${label} is required.`);
  const value = input.trim();
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters.`);
  return value;
}

function positiveInteger(input: unknown, label: string) {
  if (!Number.isInteger(input) || Number(input) < 1) throw new Error(`${label} must be a positive integer.`);
  return Number(input);
}
