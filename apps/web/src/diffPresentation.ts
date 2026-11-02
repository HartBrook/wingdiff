import type { DiffLine } from "./types";

export interface DiffLineSegments {
  before: string;
  changed: string;
  after: string;
}

export interface PresentedDiffLine extends DiffLine {
  segments?: DiffLineSegments;
}

export function presentDiffLines(lines: DiffLine[], path: string): PresentedDiffLine[] {
  const presented: PresentedDiffLine[] = lines.map((line) => ({
    ...line,
    content: line.kind === "header" ? humanizeHunkHeader(line.content, path) : line.content,
  }));

  let index = 0;
  while (index < presented.length) {
    if (presented[index]?.kind !== "deletion") {
      index += 1;
      continue;
    }

    const deletionStart = index;
    while (presented[index]?.kind === "deletion") index += 1;
    const additionStart = index;
    while (presented[index]?.kind === "addition") index += 1;

    const deletions = presented.slice(deletionStart, additionStart);
    const additions = presented.slice(additionStart, index);
    if (!additions.length || deletions.length !== additions.length) continue;

    for (let pairIndex = 0; pairIndex < deletions.length; pairIndex += 1) {
      const deletion = deletions[pairIndex]!;
      const addition = additions[pairIndex]!;
      const pair = splitChangedSpan(deletion.content, addition.content);
      if (!pair) continue;
      deletion.segments = pair.deletion;
      addition.segments = pair.addition;
    }
  }

  return presented;
}

function humanizeHunkHeader(header: string, path: string): string {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header);
  if (!match) return header;
  const newStart = Number(match[2]);
  const lineNumber = newStart === 0 ? Number(match[1]) : newStart;
  const suffix = match[3]!.trimEnd();
  return `@ ${path}:${lineNumber} @${suffix}`;
}

function splitChangedSpan(
  deletion: string,
  addition: string,
): { deletion: DiffLineSegments; addition: DiffLineSegments } | undefined {
  const deleted = Array.from(deletion);
  const added = Array.from(addition);
  let prefix = 0;
  while (prefix < deleted.length && prefix < added.length && deleted[prefix] === added[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < deleted.length - prefix &&
    suffix < added.length - prefix &&
    deleted[deleted.length - suffix - 1] === added[added.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const deletionSegments = segments(deleted, prefix, suffix);
  const additionSegments = segments(added, prefix, suffix);
  if (!deletionSegments.changed && !additionSegments.changed) return undefined;
  if (!/\S/.test(deletionSegments.before) && !/\S/.test(deletionSegments.after)) return undefined;
  return { deletion: deletionSegments, addition: additionSegments };
}

function segments(codepoints: string[], prefix: number, suffix: number): DiffLineSegments {
  return {
    before: codepoints.slice(0, prefix).join(""),
    changed: codepoints.slice(prefix, codepoints.length - suffix).join(""),
    after: codepoints.slice(codepoints.length - suffix).join(""),
  };
}
