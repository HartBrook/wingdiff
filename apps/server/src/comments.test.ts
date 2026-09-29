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
});
