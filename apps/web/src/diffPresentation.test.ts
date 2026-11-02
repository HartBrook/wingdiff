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
