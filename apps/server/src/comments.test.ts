import { describe, expect, it } from "vitest";
import { validateDraftComment } from "./comments.js";
import { parseUnifiedDiff } from "./diff.js";

const evidence = parseUnifiedDiff(`diff --git a/src/counter.ts b/src/counter.ts
index 1111111..2222222 100644
--- a/src/counter.ts
+++ b/src/counter.ts
@@ -1,3 +1,3 @@
 export function increment(value: number) {
-  return value + 1;
+  return redis.incr(value);
 }
`, "a".repeat(40), "b".repeat(40));

describe("draft comment validation", () => {
  it("accepts an exact pinned right-side anchor", () => {
    const anchor = evidence.files[0]!.hunks[0]!.lines.find((line) => line.kind === "addition")!;
    expect(validateDraftComment({
      stopId: "atomic-counter",
      evidenceId: "session-0-src/counter.ts",
      path: "src/counter.ts",
      side: "RIGHT",
      startLine: anchor.newLine,
      endLine: anchor.newLine,
      body: "Does this preserve expiry?",
      severity: "medium",
      fingerprint: anchor.fingerprint,
    }, evidence)).toMatchObject({ path: "src/counter.ts", side: "RIGHT", endLine: 2 });
  });

  it("rejects stale, cross-side, and out-of-diff anchors", () => {
    const deletion = evidence.files[0]!.hunks[0]!.lines.find((line) => line.kind === "deletion")!;
    const input = {
      stopId: "atomic-counter", evidenceId: "counter", path: "src/counter.ts", side: "RIGHT",
      startLine: 2, endLine: 2, body: "Check this.", severity: "low", fingerprint: deletion.fingerprint,
    };
    expect(() => validateDraftComment(input, evidence)).toThrow(/no longer matches/);
    expect(() => validateDraftComment({ ...input, path: "src/missing.ts" }, evidence)).toThrow(/not part/);
    expect(() => validateDraftComment({ ...input, startLine: 99, endLine: 99 }, evidence)).toThrow(/one pinned diff hunk/);
  });

  it("accepts multiline, renamed-file, and deleted-file anchors on the correct side", () => {
    const edgeEvidence = parseUnifiedDiff(`diff --git a/src/old.ts b/src/new.ts
similarity index 70%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,2 +1,3 @@
 export const first = 1;
-export const second = 2;
+export const second = 3;
+export const third = 4;
diff --git a/obsolete.ts b/obsolete.ts
deleted file mode 100644
--- a/obsolete.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const obsolete = true;
`, "a".repeat(40), "b".repeat(40));
    const renamed = edgeEvidence.files[0]!;
    const rightAnchor = renamed.hunks[0]!.lines.find((line) => line.newLine === 3)!;
    const deleted = edgeEvidence.files[1]!;
    const leftAnchor = deleted.hunks[0]!.lines[0]!;

    expect(validateDraftComment({
      stopId: "rename", evidenceId: "renamed", path: "src/new.ts", side: "RIGHT",
      startLine: 2, endLine: 3, body: "Check both exports.", severity: "low", fingerprint: rightAnchor.fingerprint,
    }, edgeEvidence)).toMatchObject({ path: "src/new.ts", startLine: 2, endLine: 3, side: "RIGHT" });
    expect(validateDraftComment({
      stopId: "deletion", evidenceId: "deleted", path: "obsolete.ts", side: "LEFT",
      startLine: 1, endLine: 1, body: "Is this removal safe?", severity: "medium", fingerprint: leftAnchor.fingerprint,
    }, edgeEvidence)).toMatchObject({ path: "obsolete.ts", side: "LEFT", endLine: 1 });
  });
});
