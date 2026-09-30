import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, readDiffEvidence } from "./diff.js";
import type { GitCommandRunner, PinnedRevisions } from "./git.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const fixture = `diff --git a/src/counter.ts b/src/counter.ts
index 1111111..2222222 100644
--- a/src/counter.ts
+++ b/src/counter.ts
@@ -1,3 +1,4 @@
 export function increment(value: number) {
-  return value + 1;
+  const next = value + 1;
+  return next;
 }
diff --git a/tests/counter.test.ts b/tests/counter.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/counter.test.ts
@@ -0,0 +1,2 @@
+import { increment } from "../src/counter";
+expect(increment(1)).toBe(2);
`;

describe("diff evidence", () => {
  it("parses exact line coordinates and stable fingerprints", () => {
    const evidence = parseUnifiedDiff(fixture, baseSha, headSha);
    expect(evidence).toMatchObject({ additions: 4, deletions: 1 });
    expect(evidence.files.map((file) => ({ path: file.path, status: file.status }))).toEqual([
      { path: "src/counter.ts", status: "modified" },
      { path: "tests/counter.test.ts", status: "added" },
    ]);

    const lines = evidence.files[0]!.hunks[0]!.lines;
    expect(lines.map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine }))).toEqual([
      { kind: "context", oldLine: 1, newLine: 1 },
      { kind: "deletion", oldLine: 2, newLine: undefined },
      { kind: "addition", oldLine: undefined, newLine: 2 },
      { kind: "addition", oldLine: undefined, newLine: 3 },
      { kind: "context", oldLine: 3, newLine: 4 },
    ]);
    expect(new Set(lines.map((line) => line.fingerprint)).size).toBe(lines.length);
    expect(parseUnifiedDiff(fixture, baseSha, headSha)).toEqual(evidence);
  });

  it("rejects truncated or internally inconsistent hunks", () => {
    const truncated = fixture.replace("@@ -1,3 +1,4 @@", "@@ -1,8 +1,9 @@");
    expect(() => parseUnifiedDiff(truncated, baseSha, headSha)).toThrow(/line counts do not match/);
  });

  it("invokes Git with pinned revisions and review-safe options", async () => {
    const calls: string[][] = [];
    const runner: GitCommandRunner = async (arguments_) => { calls.push(arguments_); return fixture; };
    const revisions: PinnedRevisions = {
      repositoryRoot: "/work/repo",
      base: { sha: baseSha, ref: "refs/wingdiff/pull/42/base" },
      head: { sha: headSha, ref: "refs/wingdiff/pull/42/head" },
    };
    const evidence = await readDiffEvidence(revisions, runner);

    expect(evidence.files).toHaveLength(2);
    expect(calls[0]).toEqual([
      "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color",
      "--find-renames", "--unified=20", baseSha, headSha, "--",
    ]);
  });

  it("uses the pinned merge base for full pull-request evidence", async () => {
    const calls: string[][] = [];
    const runner: GitCommandRunner = async (arguments_) => { calls.push(arguments_); return fixture; };
    const comparisonBaseSha = "c".repeat(40);
    const revisions: PinnedRevisions = {
      repositoryRoot: "/work/repo",
      base: { sha: baseSha, ref: "refs/wingdiff/pull/42/base" },
      head: { sha: headSha, ref: "refs/wingdiff/pull/42/head" },
      comparisonBase: { sha: comparisonBaseSha, ref: "refs/wingdiff/pull/42/comparison" },
    };

    const evidence = await readDiffEvidence(revisions, runner);

    expect(evidence.baseSha).toBe(comparisonBaseSha);
    expect(calls[0]).toContain(comparisonBaseSha);
    expect(calls[0]).not.toContain(baseSha);
  });

  it("supports deleted and binary files", () => {
    const input = `diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;
    const evidence = parseUnifiedDiff(input, baseSha, headSha);
    expect(evidence.files).toMatchObject([
      { path: "old.txt", oldPath: "old.txt", status: "deleted", deletions: 1 },
      { path: "logo.png", status: "binary", additions: 0, deletions: 0 },
    ]);
  });

  it("retains files with metadata-only changes", () => {
    const evidence = parseUnifiedDiff(`diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
`, baseSha, headSha);
    expect(evidence.files).toEqual([{
      oldPath: "script.sh",
      path: "script.sh",
      status: "modified",
      additions: 0,
      deletions: 0,
      hunks: [],
    }]);
  });
});
