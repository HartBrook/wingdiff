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
