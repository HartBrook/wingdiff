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
