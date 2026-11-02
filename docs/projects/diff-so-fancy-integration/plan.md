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

    expect(presented[0]?.segments).toEqual({ before: "const timeout = ", changed: "30", after: ";" });
    expect(presented[1]?.segments).toEqual({ before: "const timeout = ", changed: "60", after: ";" });
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

- [ ] **Step 3: Write the failing canonical-fixture test**

Add this test to `apps/web/src/fixture.test.ts`:

```typescript
  it("stores changed-line content without unified-diff markers", () => {
    const lines = [...tourStops, ...updateStops].flatMap((stop) => stop.evidence.flatMap((evidence) => evidence.lines));
    const markedLines = lines.filter((line) => (
      (line.kind === "addition" && /^[+](?: |$)/.test(line.content)) ||
      (line.kind === "deletion" && /^[-](?: |$)/.test(line.content))
    ));

    expect(markedLines).toEqual([]);
  });
```

Run:

```bash
npm test --workspace @wingdiff/web -- src/fixture.test.ts
```

Expected: FAIL because demo fixture changed lines still contain unified-diff markers.

- [ ] **Step 4: Normalize the demo fixture and verify GREEN**

Remove only the fixture-only leading `+ ` and `- ` markers from changed-line content:

```bash
perl -pi -e 's/content: "\+ /content: "/g; s/content: "- /content: "/g' apps/web/src/fixture.ts
```

Run:

```bash
npm test --workspace @wingdiff/web -- src/fixture.test.ts
```

Expected: PASS. The fixture now matches the server's canonical `DiffLine.content` shape, so the renderer never needs to guess whether a leading `+ ` or `- ` is a marker or legitimate source text.

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

Expected: PASS, 7 tests passed.

- [ ] **Step 7: Write the failing component and stylesheet tests**

Replace `apps/web/src/components/CodeDiff.test.tsx` with:

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EvidenceBlock } from "../types";
import { CodeDiff } from "./CodeDiff";

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

  it("defines strong deletion tokens and intraline emphasis CSS rules", () => {
    const cssPath = resolve(__dirname, "../styles.css");
    const css = readFileSync(cssPath, "utf-8");

    expect(css).toContain("--code-add-inline:");
    expect(css).toContain("--code-delete-inline:");
    expect(css).toContain(".diff-line__change");
    expect(css).toContain(".diff-line--addition .diff-line__change");
    expect(css).toContain(".diff-line--deletion .diff-line__change");
    expect(css).toContain(".diff-line--deletion.is-emphasized");
    expect(css).toContain(".diff-line--addition.is-emphasized");
  });
});
```

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
  --code-add-inline: rgba(106, 226, 160, 0.34);
  --code-delete-inline: rgba(255, 126, 116, 0.34);
```

Add these variables to the light `:root[data-theme="light"]` block after its `--code-delete-strong`:

```css
  --code-add-inline: rgba(36, 135, 79, 0.24);
  --code-delete-inline: rgba(185, 69, 56, 0.23);
```

Add these rules after `.diff-line__sign`:

```css
.diff-line__change { padding: 1px 0; border-radius: 2px; }
.diff-line--addition .diff-line__change { background: var(--code-add-inline); }
.diff-line--deletion .diff-line__change { background: var(--code-delete-inline); }
```

- [ ] **Step 11: Run the focused web tests and verify GREEN**

Run:

```bash
npm test --workspace @wingdiff/web -- src/diffPresentation.test.ts src/fixture.test.ts src/components/CodeDiff.test.tsx
```

Expected: PASS, all presentation and component tests pass.

- [ ] **Step 12: Document the integration boundary**

Add this paragraph under the `### Read-only change acquisition` section in `README.md`, after the paragraph ending `run untrusted code.` and before the host-specific setup details:

```markdown
The built-in diff viewer takes a lightweight cue from
[diff-so-fancy](https://github.com/so-fancy/diff-so-fancy): paired changed
lines emphasize only the intraline span that differs, and hunk headers are
reduced to a readable `@ path:line @ context` form. Wingdiff does not run the
terminal renderer or consume ANSI output; Git's structured diff remains the
authoritative source for line numbers, fingerprints, and review anchors.
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

- [ ] **Step 15: Exercise the feature in the local development server**

Run this command in a dedicated PTY session that remains alive:

```bash
npm run wingdiff -- --demo --no-open
```

Expected: the command prints an authenticated `Wingdiff is ready at` URL with a
`wingdiff_token` query parameter. Open that URL, choose the demo review, enter
Changed files, and verify that a paired replacement shows a narrower intraline
emphasis and that the hunk header uses `@ path:line @ context` instead of
`@@ ... @@`. Confirm line selection still works. Keep the server session alive for
the user and record its URL, PTY session ID, representative flow, and any
limitation in the report.

- [ ] **Step 16: Commit the validated change**

Use explicit task-owned paths:

```bash
gcommit --no-push -m "feat: add diff-so-fancy-style diff readability" -- docs/projects/diff-so-fancy-integration/plan.md apps/web/src/diffPresentation.ts apps/web/src/diffPresentation.test.ts apps/web/src/fixture.ts apps/web/src/fixture.test.ts apps/web/src/components/CodeDiff.tsx apps/web/src/components/CodeDiff.test.tsx apps/web/src/styles.css README.md
```

Expected: one local commit containing only the plan, presentation helper and tests, viewer integration, styles, and documentation. Do not push, merge, or deploy.

## Verification Receipt

The implementer report must record:
- RED command and the exact missing-behavior failure for both TDD cycles
- GREEN focused-test output
- Complete `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:e2e` results
- Exact helper coverage percentages
- Commit SHA and changed paths
- Local URL and PTY session ID for the still-running development server
- Representative demo flow and visual verification result
- Any intentional limitation, especially that diff-so-fancy itself is not bundled
