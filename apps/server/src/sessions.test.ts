import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PullRequestEvidence } from "./diff.js";
import type { PullRequestMetadata } from "./github.js";
import { defaultDatabasePath, SessionStore } from "./sessions.js";
import { parsePullRequestTarget } from "./targets.js";

const temporaryDirectories: string[] = [];
const target = parsePullRequestTarget("https://github.com/openai/codex/pull/42");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local review sessions", () => {
  it("persists and resumes acquired evidence by pinned head", async () => {
    const directory = await temporaryDirectory();
    const databasePath = path.join(directory, "nested", "wingdiff.sqlite3");
    const times = [new Date("2026-09-29T12:00:00Z"), new Date("2026-09-29T12:01:00Z")];
    const store = new SessionStore(databasePath, () => times.shift()!);
    const first = store.upsertReadySession(target, metadata(), evidence());
    const resumed = store.upsertReadySession(target, { ...metadata(), title: "Updated title" }, evidence());

    expect(resumed.id).toBe(first.id);
    expect(resumed.createdAt).toBe(first.createdAt);
    expect(resumed.updatedAt).not.toBe(first.updatedAt);
    expect(resumed.metadata.title).toBe("Updated title");
    expect(store.listSessions()).toMatchObject([{
      id: first.id,
      repository: "openai/codex",
      pullRequestNumber: 42,
      headSha: "b".repeat(40),
      status: "ready",
    }]);
    store.close();

    expect((await stat(databasePath)).isFile()).toBe(true);
    expect((await readFile(databasePath)).subarray(0, 15).toString()).toBe("SQLite format 3");
  });

  it("stores the latest explicit review checkpoint", () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata(), evidence());
    store.saveCheckpoint(session.id, {
      reviewedHeadSha: session.metadata.head.sha,
      completedAt: "2026-09-29T12:10:00Z",
      coverage: { counter: "reviewed-current" },
      findingRevisions: [{ findingId: "race", state: "resolved" }],
    });

    expect(store.latestCheckpoint(session.id)).toEqual({
      reviewedHeadSha: "b".repeat(40),
      completedAt: "2026-09-29T12:10:00Z",
      coverage: { counter: "reviewed-current" },
      findingRevisions: [{ findingId: "race", state: "resolved" }],
    });
    store.close();
  });

  it("uses a portable configurable data location", () => {
    expect(defaultDatabasePath({ WINGDIFF_DATA_DIR: "/secure/wingdiff" }, "linux")).toBe("/secure/wingdiff/wingdiff.sqlite3");
    expect(defaultDatabasePath({ XDG_DATA_HOME: "/data" }, "linux")).toBe("/data/wingdiff/wingdiff.sqlite3");
    expect(defaultDatabasePath({ LOCALAPPDATA: "C:\\Data" }, "win32")).toBe(path.join("C:\\Data", "wingdiff", "wingdiff.sqlite3"));
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "wingdiff-session-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function metadata(): PullRequestMetadata {
  return {
    number: 42,
    repository: "openai/codex",
    url: target.canonicalUrl,
    title: "Atomic counter",
    body: "",
    author: { login: "octocat" },
    base: { ref: "main", sha: "a".repeat(40) },
    head: { ref: "feature", sha: "b".repeat(40) },
    additions: 1,
    deletions: 1,
    filesChanged: 1,
    commits: [],
    checks: { passed: 1, failed: 0, pending: 0, total: 1 },
    reviews: { count: 0 },
    state: "OPEN",
    draft: false,
    updatedAt: "2026-09-29T12:00:00Z",
  };
}

function evidence(): PullRequestEvidence {
  return {
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    additions: 1,
    deletions: 1,
    files: [],
  };
}
