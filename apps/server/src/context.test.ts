import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PullRequestEvidence } from "./diff.js";
import type { PullRequestMetadata } from "./github.js";
import { buildSessionGenerationContext } from "./context.js";
import { SessionStore } from "./sessions.js";
import { parsePullRequestTarget } from "./targets.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("model context manifest", () => {
  it("shows exact included context, repository instructions, and safety classifications", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wingdiff-context-"));
    directories.push(root);
    await writeFile(path.join(root, "AGENTS.md"), "Keep review comments concise.\n", "utf8");
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence);

    const context = await buildSessionGenerationContext(session, store, "full", root);

    expect(context.manifest.instructions).toMatchObject([{ path: "AGENTS.md", content: "Keep review comments concise.\n" }]);
    expect(context.manifest.files).toMatchObject([
      { path: "src/counter.ts", included: true, classifications: [] },
      { path: ".env.production", included: false, matchedPattern: "**/.env*", classifications: ["sensitive"] },
      { path: "dist/client.min.js", included: true, classifications: ["vendor", "generated"] },
    ]);
    expect(context.manifest.warnings).toContain("1 generated or vendor file is included.");
    expect(context.manifest.promptPreview).toContain("<repository_instructions>");
    expect(context.manifest.promptPreview).toContain("Keep review comments concise.");
    expect(context.manifest.promptPreview).not.toContain("SECRET_TOKEN");
    expect(context.input.fileAnchorIds).toHaveLength(2);
    store.close();
  });

  it("applies persisted glob exclusions to generated evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wingdiff-context-"));
    directories.push(root);
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata, evidence);
    store.saveContextExclusions(session.id, ["dist/**", "**/.env*"]);

    const context = await buildSessionGenerationContext(session, store, "full", root);

    expect(context.evidence.files.map((file) => file.path)).toEqual(["src/counter.ts"]);
    expect(context.manifest.excludedFiles).toBe(2);
    store.close();
  });

  it("blocks oversized model context before provider dispatch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wingdiff-context-"));
    directories.push(root);
    const store = new SessionStore(":memory:");
    const oversizedEvidence = { ...evidence, files: [changedFile("src/fixture.txt", "x".repeat(751_000), "large")] };
    const session = store.upsertReadySession(target, metadata, oversizedEvidence);

    const context = await buildSessionGenerationContext(session, store, "full", root);

    expect(context.manifest.ready).toBe(false);
    expect(context.manifest.warnings.join(" ")).toMatch(/exceeds 750,000/);
    store.close();
  });
});

const target = parsePullRequestTarget("https://github.com/openai/codex/pull/42");
const metadata = {
  number: 42, repository: "openai/codex", url: target.canonicalUrl, title: "Atomic counter", body: "Fix concurrent updates.",
  author: { login: "octocat" }, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature", sha: "b".repeat(40) },
  additions: 3, deletions: 0, filesChanged: 3, commits: [], checks: { passed: 1, failed: 0, pending: 0, total: 1 }, reviews: { count: 0 },
  state: "OPEN", draft: false, updatedAt: "2026-09-29T12:00:00Z",
} satisfies PullRequestMetadata;
const evidence = {
  baseSha: metadata.base.sha, headSha: metadata.head.sha, additions: 3, deletions: 0,
  files: [
    changedFile("src/counter.ts", "return redis.incr(key)", "counter"),
    changedFile(".env.production", "SECRET_TOKEN=abc", "secret"),
    changedFile("dist/client.min.js", "/* code generated; do not edit */", "generated"),
  ],
} satisfies PullRequestEvidence;

function changedFile(filePath: string, content: string, fingerprint: string): PullRequestEvidence["files"][number] {
  return {
    path: filePath, status: "added", additions: 1, deletions: 0,
    hunks: [{ header: "@@ -0,0 +1 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 1,
      lines: [{ kind: "addition", content, newLine: 1, fingerprint }] }],
  };
}
