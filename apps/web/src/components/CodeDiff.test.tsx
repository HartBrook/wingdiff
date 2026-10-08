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
      { kind: "deletion", oldLine: 2, content: "- snap_count=old", emphasized: true },
      { kind: "addition", newLine: 2, content: "+ snap_count=new", emphasized: true },
      { kind: "context", oldLine: 3, newLine: 3, content: "  exit 0" },
    ],
  };

  it("renders diff lines with deletion, addition, and emphasized classes", () => {
    const html = renderToStaticMarkup(<CodeDiff evidence={sampleEvidence} />);

    expect(html).toContain("diff-line--deletion is-emphasized");
    expect(html).toContain("diff-line--addition is-emphasized");
    expect(html).toContain("diff-line--context");
  });

  it("defines strong deletion tokens and emphasized deletion CSS rules in styles.css", () => {
    const cssPath = resolve(__dirname, "../styles.css");
    const css = readFileSync(cssPath, "utf-8");

    expect(css).toContain("--code-delete-strong:");
    expect(css).toContain(".diff-line--deletion.is-emphasized");
    expect(css).toContain(".diff-line--addition.is-emphasized");
  });
});
