# Diff-so-fancy-style Diff Readability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add diff-so-fancy-style word-level change emphasis and simplified hunk headers to Wingdiff's built-in diff viewer without changing the authoritative Git diff or review anchors.

**Architecture:** A new pure presentation module pairs consecutive equal-length deletion/addition runs, computes an intraline changed span from the common prefix and suffix, and converts machine-oriented hunk headers into a compact human-readable form. `CodeDiff` renders those spans while retaining every line's original line numbers, fingerprints, selection behavior, and evidence metadata. No terminal executable, ANSI parser, or new runtime dependency is introduced.

**Tech Stack:** React 19, TypeScript 7, Vitest 5, CSS variables

## Global Constraints

- Keep `apps/server/src/diff.ts` and the acquired unified diff authoritative. Do not alter hunk boundaries, line numbers, fingerprints, file statuses, review coverage, or comment anchors.
- Do not invoke `diff-so-fancy`, depend on Perl, execute reviewed repository code, or add a runtime dependency.
- Preserve selection and accessibility behavior. Line number buttons must remain the interaction target.
- Treat diff-so-fancy as the inspiration for readable presentation, not as a browser renderer. The integration boundary is the React presentation layer.
- Implement test-first. Watch each new test fail for the intended missing behavior before writing production code.
- Normalize demo fixture content to the server's canonical shape: changed-line content never includes the unified-diff `+ ` or `- ` marker. Preserve legitimate source content that happens to begin with `+ ` or `- `.
- New helper coverage must be greater than 90 percent, measured over `apps/web/src/diffPresentation.ts`.

---

### Task 1: Diff-so-fancy-style diff presentation

**Files:**
- Create: `apps/web/src/diffPresentation.ts`
- Create: `apps/web/src/diffPresentation.test.ts`
- Modify: `apps/web/src/fixture.ts`
- Modify: `apps/web/src/fixture.test.ts`
- Modify: `apps/web/src/components/CodeDiff.tsx`
- Modify: `apps/web/src/components/CodeDiff.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `e2e/reviewer-flow.spec.ts`
- Modify: `README.md`

**Interfaces:**
- `presentDiffLines(lines: DiffLine[], path: string): PresentedDiffLine[]`
- `PresentedDiffLine extends DiffLine` and optionally carries `segments: { before: string; changed: string; after: string }`
- `CodeDiff` continues to accept the existing `CodeDiffProps`; its callers do not change.
- `DiffLine`, `EvidenceBlock`, and all server-side diff types remain unchanged.

- [ ] **Step 1: Write the failing presentation tests**

Create `apps/web/src/diffPresentation.test.ts` with:

```typescript
import { describe, expect, it } from "vitest";
import type { DiffLine } from "./types";
import { presentDiffLines } from "./diffPresentation";

describe("presentDiffLines", () => {
  it("marks only the changed span in paired deletion and addition lines", () => {
    const lines: DiffLine[] = [
      { kind: "deletion", oldLine: 7, content: "const timeout = 30;" },
      { kind: "addition", newLine: 7, content: "const timeout = 60;" },
    ];

    const presented = presentDiffLines(lines, "src/timeouts.ts");

    expect(presented[0]?.segments).toEqual({ before: "const timeout = ", changed: "3", after: "0;" });
    expect(presented[1]?.segments).toEqual({ before: "const timeout = ", changed: "6", after: "0;" });
  });

  it("uses Unicode code points when finding the changed span", () => {
    const lines: DiffLine[] = [
      { kind: "deletion", oldLine: 3, content: "const label = \"café old\";" },
      { kind: "addition", newLine: 3, content: "const label = \"café new\";" },
    ];

    const presented = presentDiffLines(lines, "src/labels.ts");

    expect(presented[0]?.segments).toEqual({ before: "const label = \"café ", changed: "old", after: "\";" });
    expect(presented[1]?.segments).toEqual({ before: "const label = \"café ", changed: "new", after: "\";" });
  });

  it("keeps supplementary-plane code points intact", () => {
    const lines: DiffLine[] = [
      { kind: "deletion", oldLine: 3, content: "const marker = \"😀\";" },
      { kind: "addition", newLine: 3, content: "const marker = \"😁\";" },
    ];

    const presented = presentDiffLines(lines, "src/labels.ts");

    expect(presented[0]?.segments).toEqual({ before: "const marker = \"", changed: "😀", after: "\";" });
    expect(presented[1]?.segments).toEqual({ before: "const marker = \"", changed: "😁", after: "\";" });
  });

  it("suppresses intraline segments for complete replacements", () => {
    const lines: DiffLine[] = [
      { kind: "deletion", oldLine: 4, content: "old" },
      { kind: "addition", newLine: 4, content: "new" },
    ];

    expect(presentDiffLines(lines, "file.txt").every((line) => line.segments === undefined)).toBe(true);
  });

  it("ignores whitespace-only common affixes when deciding whether to segment", () => {
    const lines: DiffLine[] = [
      { kind: "deletion", oldLine: 4, content: "    old" },
      { kind: "addition", newLine: 4, content: "    new" },
    ];

    expect(presentDiffLines(lines, "file.txt").every((line) => line.segments === undefined)).toBe(true);
  });

  it("leaves unbalanced replacement runs unsegmented", () => {
    const lines: DiffLine[] = [
      { kind: "deletion", oldLine: 2, content: "one()" },
      { kind: "addition", newLine: 2, content: "uno()" },
      { kind: "addition", newLine: 3, content: "dos()" },
    ];

    expect(presentDiffLines(lines, "src/count.ts").every((line) => line.segments === undefined)).toBe(true);
  });

  it("preserves source content that begins with a diff marker", () => {
    const lines: DiffLine[] = [
      { kind: "addition", newLine: 4, content: "+ Markdown list item" },
    ];

    const presented = presentDiffLines(lines, "README.md");

    expect(presented[0]?.content).toBe("+ Markdown list item");
    expect(presented[0]?.segments).toBeUndefined();
  });

  it("does not emphasize identical paired lines", () => {
    const lines: DiffLine[] = [
      { kind: "deletion", oldLine: 4, content: "same" },
      { kind: "addition", newLine: 4, content: "same" },
    ];

    expect(presentDiffLines(lines, "file.txt").every((line) => line.segments === undefined)).toBe(true);
  });

  it("simplifies standard hunk headers and preserves non-hunk headers", () => {
    const presented = presentDiffLines([
      { kind: "header", content: "@@ -41,8 +41,18 @@ export async function login(input: LoginInput) {" },
      { kind: "header", content: "@@ -10,2 +0,0 @@" },
      { kind: "header", content: "Binary file changed" },
    ], "src/auth/login.ts");

    expect(presented[0]?.content).toBe("@ src/auth/login.ts:41 @ export async function login(input: LoginInput) {");
    expect(presented[1]?.content).toBe("@ src/auth/login.ts:10 @");
    expect(presented[2]?.content).toBe("Binary file changed");
  });

  it("uses the deleted range start when a nonzero new range is empty", () => {
    const presented = presentDiffLines([
      { kind: "header", content: "@@ -10,2 +9,0 @@" },
    ], "src/auth/login.ts");

    expect(presented[0]?.content).toBe("@ src/auth/login.ts:10 @");
  });

  it("does not mutate the supplied evidence lines", () => {
    const lines: DiffLine[] = [
      { kind: "deletion", oldLine: 4, content: "old" },
      { kind: "addition", newLine: 4, content: "new" },
    ];
    const original = structuredClone(lines);

    presentDiffLines(lines, "file.txt");

    expect(lines).toEqual(original);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test --workspace @wingdiff/web -- src/diffPresentation.test.ts
```

Expected: FAIL because `./diffPresentation` does not exist. If Vitest reports another reason, fix the test invocation or imports and rerun until the failure is specifically the missing module.

- [ ] **Step 3: Write the failing fixture intraline test**

Import `presentDiffLines` into `apps/web/src/fixture.test.ts` and add this test:

```typescript
  it("includes an intraline replacement in the update review", () => {
    const segments = updateStops.flatMap((stop) => stop.evidence.flatMap((evidence) => (
      presentDiffLines(evidence.lines, evidence.path).flatMap((line) => line.segments ? [line.segments] : [])
    )));

    expect(segments.map((segment) => segment.changed)).toEqual(expect.arrayContaining([
      "Number(await this.redis.get(key) ?? 0) + 1",
      "await this.redis.eval(INCREMENT_WITH_TTL, { keys: [key], arguments: [ttlMs] })",
    ]));
  });
```

Run:

```bash
npm test --workspace @wingdiff/web -- src/fixture.test.ts
```

Expected: FAIL because the update evidence has no equal-length deletion/addition pair, so `presentDiffLines` produces no segments.

- [ ] **Step 4: Add a natural equal-length replacement to the demo fixture and verify GREEN**

In the `redis-increment-update` evidence block, replace the unbalanced three-line deletion and five-line addition with a small coherent replacement:

```typescript
{ kind: "context", oldLine: 20, newLine: 20, content: "async increment(subject: string, ttlMs: number) {" },
{ kind: "deletion", oldLine: 21, content: "  const next = Number(await this.redis.get(key) ?? 0) + 1;", emphasized: true },
{ kind: "addition", newLine: 21, content: "  const next = await this.redis.eval(INCREMENT_WITH_TTL, { keys: [key], arguments: [ttlMs] });", emphasized: true },
{ kind: "context", oldLine: 22, newLine: 22, content: "  return next;" },
{ kind: "context", oldLine: 23, newLine: 23, content: "}" },
```

Run:

```bash
npm test --workspace @wingdiff/web -- src/fixture.test.ts
```

Expected: PASS. The update review now has a natural equal-length replacement with a shared `const next = ` prefix and `;` suffix, so the browser can show an intraline segment.

- [ ] **Step 5: Implement the minimal presentation helper**

Create `apps/web/src/diffPresentation.ts` with:

```typescript
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
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(header);
  if (!match) return header;
  const newStart = Number(match[2]);
  const newLines = match[3] === undefined ? 1 : Number(match[3]);
  const lineNumber = newLines === 0 ? Number(match[1]) : newStart;
  const suffix = match[4]!.trimEnd();
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
```

- [ ] **Step 6: Run the helper tests and verify GREEN**

Run:

```bash
npm test --workspace @wingdiff/web -- src/diffPresentation.test.ts
```

Expected: PASS, 11 tests passed. The deletion-only header test covers both a zero new start (`+0,0`) and a nonzero new start with a zero count (`+9,0`).

- [ ] **Step 7: Write the failing component and stylesheet tests**

Replace `apps/web/src/components/CodeDiff.test.tsx` with:

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EvidenceBlock } from "../types";
import { CodeDiff } from "./CodeDiff";

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

describe("CodeDiff", () => {
  const sampleEvidence: EvidenceBlock = {
    id: "evidence-1",
    path: ".github/workflows/ci.yml",
    label: "Modified +1 -1",
    language: "YAML",
    startLine: 1,
    endLine: 3,
    lines: [
      { kind: "header", content: "@@ -1,3 +1,3 @@" },
      { kind: "deletion", oldLine: 2, content: "snap_count=30", emphasized: true },
      { kind: "addition", newLine: 2, content: "snap_count=60", emphasized: true },
      { kind: "context", oldLine: 3, newLine: 3, content: "exit 0" },
    ],
  };

  it("renders diff lines with deletion, addition, and emphasized classes", () => {
    const html = renderToStaticMarkup(<CodeDiff evidence={sampleEvidence} />);

    expect(html).toContain("diff-line--deletion is-emphasized");
    expect(html).toContain("diff-line--addition is-emphasized");
    expect(html).toContain("diff-line--context");
  });

  it("renders the simplified hunk header and intraline change spans", () => {
    const html = renderToStaticMarkup(<CodeDiff evidence={sampleEvidence} />);

    expect(html).toContain("@ .github/workflows/ci.yml:1 @");
    expect(html).not.toContain("@@ -1,3 +1,3 @@");
    expect(html).toContain("diff-line__change");
    expect(html).toContain("syntax-number");
  });

  it("keeps syntax classes on changed string content", () => {
    const evidence: EvidenceBlock = {
      ...sampleEvidence,
      path: "src/labels.ts",
      lines: [
        { kind: "deletion", oldLine: 3, content: "const label = \"café old\";" },
        { kind: "addition", newLine: 3, content: "const label = \"café new\";" },
      ],
    };

    const html = renderToStaticMarkup(<CodeDiff evidence={evidence} />);

    expect(html).toContain("diff-line__change syntax-string");
    expect(html).toContain("old");
    expect(html).toContain("new");
  });

  it("uses high-contrast intraline underlines without filled backgrounds", () => {
    const cssPath = resolve(__dirname, "../styles.css");
    const css = readFileSync(cssPath, "utf-8");
    const additionChange = ruleBody(css, ".diff-line--addition .diff-line__change");
    const deletionChange = ruleBody(css, ".diff-line--deletion .diff-line__change");

    expect(css).toContain("--code-add-inline: #6ae2a0;");
    expect(css).toContain("--code-delete-inline: #ff7e74;");
    expect(css).toContain("--code-add-inline: #21794e;");
    expect(css).toContain("--code-delete-inline: #b94538;");
    expect(additionChange).toContain("box-shadow: inset 0 -2px 0 var(--code-add-inline);");
    expect(deletionChange).toContain("box-shadow: inset 0 -2px 0 var(--code-delete-inline);");
    expect(additionChange).not.toContain("background");
    expect(deletionChange).not.toContain("background");
    expect(css).toContain(".diff-line--addition { background: var(--code-add); }");
    expect(css).toContain(".diff-line--deletion { background: var(--code-delete); }");
    expect(css).toContain(".diff-line--deletion.is-emphasized");
    expect(css).toContain(".diff-line--addition.is-emphasized");
  });

  it("preserves intraline distinction in forced-colors mode", () => {
    const cssPath = resolve(__dirname, "../styles.css");
    const css = readFileSync(cssPath, "utf-8");
    const forcedColorsChange = /@media \(forced-colors: active\) \{[\s\S]*?\.diff-line--addition \.diff-line__change,\s*\.diff-line--deletion \.diff-line__change\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

    expect(forcedColorsChange).toContain("text-decoration: underline;");
    expect(forcedColorsChange).toContain("text-decoration-color: CanvasText;");
    expect(forcedColorsChange).toContain("text-decoration-thickness: 2px;");
    expect(forcedColorsChange).toContain("text-underline-offset: 2px;");
  });
});
```

The stylesheet assertions extract each changed-span rule and verify the exact dark/light opaque colors, the two `box-shadow: inset 0 -2px 0 ...` declarations, the absence of `background` in those rules, and the existing whole-row addition/deletion backgrounds. They also require a forced-colors fallback that underlines both addition and deletion changes with the `CanvasText` system color.

- [ ] **Step 8: Run the component tests and verify RED**

Run:

```bash
npm test --workspace @wingdiff/web -- src/components/CodeDiff.test.tsx
```

Expected: FAIL because the current renderer emits the raw `@@` hunk header and has no `.diff-line__change` output. Confirm the failure names those missing behaviors, not an import or syntax error.

- [ ] **Step 9: Integrate presentation into `CodeDiff`**

Replace `apps/web/src/components/CodeDiff.tsx` with:

```tsx
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
```

- [ ] **Step 10: Add intraline CSS variables and rendering rules**

In `apps/web/src/styles.css`, add these variables to the dark `:root` block after `--code-delete-strong`:

```css
  --code-add-inline: #6ae2a0;
  --code-delete-inline: #ff7e74;
```

Add these variables to the light `:root[data-theme="light"]` block after its `--code-delete-strong`:

```css
  --code-add-inline: #21794e;
  --code-delete-inline: #b94538;
```

Add these rules after `.diff-line__sign`:

```css
.diff-line__change { padding: 1px 0; border-radius: 2px; }
.diff-line--addition .diff-line__change { box-shadow: inset 0 -2px 0 var(--code-add-inline); }
.diff-line--deletion .diff-line__change { box-shadow: inset 0 -2px 0 var(--code-delete-inline); }
@media (forced-colors: active) {
  .diff-line--addition .diff-line__change,
  .diff-line--deletion .diff-line__change {
    text-decoration: underline;
    text-decoration-color: CanvasText;
    text-decoration-thickness: 2px;
    text-underline-offset: 2px;
  }
}
```

The whole-row addition/deletion backgrounds remain unchanged. Changed spans must not add a text background; the stylesheet test rejects `background` inside both changed-span rules and asserts the exact opaque underline colors and inset rules. Forced-colors mode suppresses `box-shadow`, so the media fallback conveys the changed span with a 2px text underline using `CanvasText`.

- [ ] **Step 11: Add the focused browser proof and run focused tests**

Add this Playwright test to `e2e/reviewer-flow.spec.ts`:

```typescript
test("shows a readable, selectable intraline replacement in the demo update review", async ({ page }) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Review updates" }).click();

  await expect(page.locator(".diff-line__change").first()).toBeVisible();
  const header = page.locator(".diff-line__header").first();
  await expect(header).toHaveText(/^@ src\/infra\/redis\/attempt-store\.ts:\d+ @/);
  await expect(header).not.toContainText("@@");

  const changedRow = page.locator(".diff-line--deletion, .diff-line--addition").first();
  const lineButton = changedRow.locator(".diff-line__number");
  await expect(lineButton).toBeEnabled();
  await lineButton.click();
  await expect(changedRow).toHaveClass(/is-selected/);
});
```

The proof opens `/?demo=1`, selects `Review updates`, and verifies that a readable intraline replacement is visible, the active header uses the humanized form rather than `@@`, and a line-number button in a changed row remains selectable.

Run the focused browser test:

```bash
npx playwright test e2e/reviewer-flow.spec.ts --grep "readable, selectable intraline replacement"
```

Expected: PASS, 1 test passed.

Run:

```bash
npm test --workspace @wingdiff/web -- src/diffPresentation.test.ts src/fixture.test.ts src/components/CodeDiff.test.tsx
```

Expected: PASS, 25 presentation, fixture, and component tests across 3 files.

- [ ] **Step 12: Document the integration boundary**

Add this paragraph under the `### Read-only change acquisition` section in `README.md`, after the paragraph ending `run untrusted code.` and before the host-specific setup details:

```markdown
The built-in diff viewer takes a lightweight cue from
[diff-so-fancy](https://github.com/so-fancy/diff-so-fancy): paired changed
lines with meaningful shared context emphasize only the intraline span that
differs, and hunk headers are reduced to a readable `@ path:line @ context`
form. Wingdiff does not run the terminal renderer or consume ANSI output;
Git's structured diff remains the authoritative source for line numbers,
fingerprints, and review anchors.
```

- [ ] **Step 13: Run the complete repository verification**

Run, in order:

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
```

Expected: all server and web unit tests pass, TypeScript reports no errors, both workspaces build, and Playwright's mocked review flow passes.

- [ ] **Step 14: Measure helper coverage**

Install the matching coverage provider without saving it or changing the lockfile:

```bash
npm install --no-save --package-lock=false @vitest/coverage-v8@5.0.3
```

Then run:

```bash
npm exec --workspace @wingdiff/web -- vitest run src/diffPresentation.test.ts --coverage --coverage.include=src/diffPresentation.ts --coverage.reporter=text
```

Expected: `diffPresentation.ts` has greater than 90 percent statements, branches, functions, and lines. If any metric is at or below 90 percent, add tests for the uncovered behavior, rerun the focused test to observe it fail when the behavior is absent, then implement and rerun. Report the exact four coverage percentages.

- [ ] **Step 15: Leave server verification to the controller**

Do not leave a development or demo server running. The focused and full
Playwright runs own the browser-level proof and shut their web server down when
they exit. The controller may perform a separate persistent authenticated
server check after the fix wave; record that URL and session only if the check
is delegated.

- [ ] **Step 16: Commit the validated change**

Use explicit task-owned paths:

```bash
gcommit --no-push -m "fix: refine diff presentation and demo coverage" -- docs/projects/diff-so-fancy-integration/plan.md apps/web/src/diffPresentation.ts apps/web/src/diffPresentation.test.ts apps/web/src/fixture.ts apps/web/src/fixture.test.ts apps/web/src/components/CodeDiff.tsx apps/web/src/components/CodeDiff.test.tsx apps/web/src/styles.css README.md e2e/reviewer-flow.spec.ts
```

Expected: one local commit containing only the plan, presentation helper and tests, viewer integration, styles, browser coverage, and documentation. Do not push, merge, or deploy.

## Verification Receipt

The fix-wave implementer report records:

- RED/GREEN evidence for deletion-only hunk headers, exact intraline spans, meaningful-affix suppression, high-contrast underline CSS, the forced-colors text fallback, the fixture replacement, and the focused Playwright flow.
- Focused web verification: 3 files passed, 25 tests passed.
- Focused demo Playwright verification: 1 test passed.
- Complete `npm test`: 24 server files / 151 tests and 10 web files / 66 tests passed.
- `npm run typecheck`: server and web both passed.
- `npm run build`: web (321 modules) and server both passed.
- Full `npm run test:e2e`: 8 tests passed.
- Helper coverage: statements 100% (51/51), branches 96.66% (29/30), functions 100% (5/5), lines 100% (41/41).
- The temporary coverage provider was installed without changing package manifests or the lockfile, then `npm ci` restored the locked dependency tree.
- No development server was left running; the controller owns the persistent authenticated server check.
- The final P3 accessibility fix adds only the forced-colors stylesheet contract, the fallback rule, and this plan update. Its SHA and changed paths are recorded in `task-1-report.md` after commit.
- Diff-so-fancy itself remains intentionally unbundled; Wingdiff presents structured Git data and does not execute Perl, parse ANSI, or add a runtime dependency.
