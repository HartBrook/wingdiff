import { memo, useMemo } from "react";
import { presentDiffLines, type DiffLineSegments } from "../diffPresentation";
import type { EvidenceBlock } from "../types";
import { Icon } from "./Icon";

interface Selection {
  evidenceId: string;
  side?: "LEFT" | "RIGHT";
  start: number;
  end: number;
}

interface CodeDiffProps {
  evidence: EvidenceBlock;
  selection?: Selection | null;
  onSelectLine?: (evidenceId: string, line: number, side: "LEFT" | "RIGHT", extend: boolean) => void;
  onAsk?: () => void;
  onComment?: () => void;
  minimal?: boolean;
}

export const CodeDiff = memo(function CodeDiff({
  evidence,
  selection,
  onSelectLine,
  onAsk,
  onComment,
  minimal = false,
}: CodeDiffProps) {
  const selectedCount = selection?.evidenceId === evidence.id
    ? Math.abs(selection.end - selection.start) + 1
    : 0;
  const lines = useMemo(
    () => presentDiffLines(evidence.lines, evidence.path),
    [evidence.lines, evidence.path],
  );

  return (
    <section className="diff-card" aria-label={`${evidence.path} diff`}>
      <header className="diff-card__header">
        <div className="diff-card__identity">
          <span className="diff-card__file-icon"><Icon name="code" size={15} /></span>
          <div>
            <strong>{fileName(evidence.path)}</strong>
            <span>{directoryName(evidence.path)}</span>
          </div>
        </div>
        <div className="diff-card__meta">
          <span>{evidence.label}</span>
          <span className="diff-card__language">{evidence.language}</span>
        </div>
      </header>

      <div className="diff-card__code" role="table">
        {lines.map((line, index) => {
          const side = line.kind === "deletion" ? "LEFT" : "RIGHT";
          const lineNumber = side === "RIGHT" ? line.newLine : line.oldLine;
          const selected = Boolean(
            lineNumber &&
            selection?.evidenceId === evidence.id &&
            (!selection.side || selection.side === side) &&
            lineNumber >= Math.min(selection.start, selection.end) &&
            lineNumber <= Math.max(selection.start, selection.end),
          );
          return (
            <div
              className={`diff-line diff-line--${line.kind} ${line.emphasized ? "is-emphasized" : ""} ${selected ? "is-selected" : ""}`}
              key={`${line.kind}-${lineNumber ?? "h"}-${index}`}
              role="row"
            >
              {line.kind === "header" ? (
                <><span className="diff-line__gutter" /><span className="diff-line__header">{line.content}</span></>
              ) : (
                <>
                  <button
                    aria-label={`Select line ${lineNumber ?? "context"}`}
                    className="diff-line__number"
                    disabled={!onSelectLine || !lineNumber}
                    onClick={(event) => lineNumber && onSelectLine?.(evidence.id, lineNumber, side, event.shiftKey)}
                    type="button"
                  >
                    {lineNumber}
                  </button>
                  <span aria-hidden="true" className="diff-line__sign">
                    {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : ""}
                  </span>
                  <code>{highlight(line.content, line.segments)}</code>
                </>
              )}
            </div>
          );
        })}
      </div>

      {!minimal && (
        <footer className="diff-card__footer">
          <span className={selectedCount ? "selection-label is-active" : "selection-label"}>
            {selectedCount ? `${selectedCount} line${selectedCount === 1 ? "" : "s"} selected` : "Select a line to anchor feedback"}
          </span>
          <div>
            <button className="button button--quiet button--small" onClick={onAsk} type="button">
              <Icon name="spark" size={14} /> Ask
            </button>
            <button className="button button--quiet button--small" onClick={onComment} type="button">
              <Icon name="comment" size={14} /> Comment
            </button>
          </div>
        </footer>
      )}
    </section>
  );
});

function fileName(path: string) {
  return path.split("/").at(-1) ?? path;
}

function directoryName(path: string) {
  const parts = path.split("/");
  parts.pop();
  return parts.length ? `${parts.join("/")}/` : "";
}

function highlight(content: string, segments?: DiffLineSegments) {
  const changeStart = segments?.before.length ?? -1;
  const changeEnd = segments ? changeStart + segments.changed.length : -1;
  return syntaxTokens(content).flatMap((token, tokenIndex) => (
    splitToken(content, token, changeStart, changeEnd).map((part, partIndex) => (
      <span
        className={part.changed ? `diff-line__change ${token.className}`.trim() : token.className || undefined}
        key={`${token.start}-${tokenIndex}-${partIndex}`}
      >
        {part.text}
      </span>
    ))
  ));
}

interface SyntaxToken {
  start: number;
  end: number;
  className: string;
}

function syntaxTokens(content: string): SyntaxToken[] {
  const pattern = /(\"[^\"]*\"|'[^']*'|`[^`]*`|\b(?:async|await|const|return|if|else|new|throw|class|private|export|function|true|false|null|undefined)\b|\b\d+\b)/g;
  const tokens: SyntaxToken[] = [];
  let cursor = 0;
  for (const match of content.matchAll(pattern)) {
    const start = match.index;
    if (start > cursor) tokens.push({ start: cursor, end: start, className: "" });
    const text = match[0];
    tokens.push({ start, end: start + text.length, className: syntaxClass(text) });
    cursor = start + text.length;
  }
  if (cursor < content.length) tokens.push({ start: cursor, end: content.length, className: "" });
  return tokens;
}

function syntaxClass(token: string): string {
  if (/^[\"'`]/.test(token)) return "syntax-string";
  if (/^\d+$/.test(token)) return "syntax-number";
  return "syntax-keyword";
}

function splitToken(content: string, token: SyntaxToken, changeStart: number, changeEnd: number) {
  const boundaries = [token.start, token.end];
  if (changeStart > token.start && changeStart < token.end) boundaries.push(changeStart);
  if (changeEnd > token.start && changeEnd < token.end) boundaries.push(changeEnd);
  boundaries.sort((left, right) => left - right);

  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]!;
    return {
      text: content.slice(start, end),
      start,
      end,
      changed: changeStart >= 0 && start >= changeStart && end <= changeEnd,
    };
  });
}
