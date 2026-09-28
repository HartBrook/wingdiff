import type { InvestigationContext } from "./providers/types.js";

const MAX_QUESTION_LENGTH = 4_000;
const MAX_EVIDENCE_LINES = 1_000;

export function validateInvestigationContext(input: unknown): InvestigationContext {
  if (!input || typeof input !== "object") throw new Error("Investigation context is required.");
  const value = input as Record<string, unknown>;
  if (typeof value.question !== "string" || !value.question.trim()) throw new Error("Question is required.");
  if (value.question.length > MAX_QUESTION_LENGTH) throw new Error("Question is too long.");
  if (!value.stop || typeof value.stop !== "object") throw new Error("Review stop is required.");

  const stop = value.stop as Record<string, unknown>;
  for (const field of ["title", "summary", "why"] as const) {
    if (typeof stop[field] !== "string") throw new Error(`Review stop ${field} is required.`);
  }
  if (!Array.isArray(stop.claims) || !Array.isArray(stop.evidence)) {
    throw new Error("Claims and evidence must be arrays.");
  }
  const lineCount = stop.evidence.reduce((count, item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid evidence item.");
    const lines = (item as Record<string, unknown>).lines;
    if (!Array.isArray(lines)) throw new Error("Evidence lines must be an array.");
    return count + lines.length;
  }, 0);
  if (lineCount > MAX_EVIDENCE_LINES) throw new Error("Evidence exceeds the investigation limit.");

  return input as InvestigationContext;
}

