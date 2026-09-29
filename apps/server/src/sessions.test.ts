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
      scope: "full",
      coverage: { counter: "reviewed-current" },
      findingRevisions: [{ findingId: "race", title: "Counter race", severity: "high", state: "resolved", summary: "Resolved by the reviewer.", pathHints: ["counter.ts"] }],
    });

    expect(store.latestCheckpoint(session.id)).toEqual({
      reviewedHeadSha: "b".repeat(40),
      completedAt: "2026-09-29T12:10:00Z",
      scope: "full",
      coverage: { counter: "reviewed-current" },
      findingRevisions: [{ findingId: "race", title: "Counter race", severity: "high", state: "resolved", summary: "Resolved by the reviewer.", pathHints: ["counter.ts"] }],
    });
    store.close();
  });

  it("keeps full and update checkpoints for the same head", () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata(), evidence());
    store.saveCheckpoint(session.id, {
      reviewedHeadSha: session.metadata.head.sha, completedAt: "2026-09-29T12:10:00Z", scope: "full",
      coverage: { "full-counter": "understood" }, findingRevisions: [],
    });
    store.saveCheckpoint(session.id, {
      reviewedHeadSha: session.metadata.head.sha, completedAt: "2026-09-29T12:11:00Z", scope: "update",
      coverage: { "update-counter": "flagged" }, findingRevisions: [],
    });

    expect(store.latestCheckpoint(session.id, "full")?.coverage).toEqual({ "full-counter": "understood" });
    expect(store.latestCheckpoint(session.id, "update")?.coverage).toEqual({ "update-counter": "flagged" });
    expect(store.latestCheckpoint(session.id)?.scope).toBe("update");
    store.close();
  });

  it("stores one generated tour for the pinned session revision", () => {
    const times = [new Date("2026-09-29T12:00:00Z"), new Date("2026-09-29T12:02:00Z")];
    const store = new SessionStore(":memory:", () => times.shift()!);
    const session = store.upsertReadySession(target, metadata(), evidence());
    const stored = store.saveTour(
      session.id,
      "full",
      { provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" },
      session.metadata.base.sha,
      session.metadata.head.sha,
      {
        summary: "The counter change is small and focused.",
        findingRevisions: [],
        stops: [{
          id: "counter",
          title: "Counter update",
          summary: "The counter changes.",
          purpose: "Check behavior.",
          anchorIds: ["file_001"],
          claims: [{ text: "One file changes.", kind: "fact", confidence: "high", anchorIds: ["file_001"] }],
          prompts: [],
        }],
      },
    );

    expect(stored).toMatchObject({
      sessionId: session.id,
      scope: "full",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      selection: { provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" },
      tour: { summary: "The counter change is small and focused." },
    });
    expect(Number(store.database.prepare("PRAGMA user_version").get()?.user_version)).toBe(12);
    store.close();
  });

  it("persists session-scoped draft comments", () => {
    const store = new SessionStore(":memory:", () => new Date("2026-09-29T12:00:00Z"));
    const session = store.upsertReadySession(target, metadata(), evidence());
    const comment = store.saveDraftComment(session.id, {
      stopId: "counter", evidenceId: "counter-file", path: "src/counter.ts", side: "RIGHT",
      startLine: 2, endLine: 2, body: "Does this preserve expiry?", severity: "medium", fingerprint: "line-new",
    });

    expect(store.listDraftComments(session.id)).toEqual([comment]);
    expect(comment).toMatchObject({ sessionId: session.id, stopId: "counter", severity: "medium" });
    expect(store.deleteDraftComment(session.id, comment.id)).toBe(true);
    expect(store.listDraftComments(session.id)).toEqual([]);
    store.close();
  });

  it("persists the review summary and disposition", () => {
    const store = new SessionStore(":memory:", () => new Date("2026-09-29T12:00:00Z"));
    const session = store.upsertReadySession(target, metadata(), evidence());

    expect(store.getReviewDraft(session.id)).toBeUndefined();
    expect(store.saveReviewDraft(session.id, "Ready after the expiry question is answered.", "COMMENT")).toEqual({
      sessionId: session.id,
      body: "Ready after the expiry question is answered.",
      event: "COMMENT",
      updatedAt: "2026-09-29T12:00:00.000Z",
    });
    expect(store.getReviewDraft(session.id)?.event).toBe("COMMENT");
    expect(store.saveSubmittedReview(session.id, session.metadata.head.sha, 91, "https://github.com/review/91", {
      body: "Ready after the expiry question is answered.", event: "COMMENT",
    }, [])).toMatchObject({ githubReviewId: 91, event: "COMMENT", comments: [] });
    expect(store.getSubmittedReview(session.id, session.metadata.head.sha)?.url).toBe("https://github.com/review/91");
    store.close();
  });

  it("persists investigation notebook entries", () => {
    const times = [
      new Date("2026-09-29T12:00:00Z"),
      new Date("2026-09-29T12:01:00Z"),
      new Date("2026-09-29T12:02:00Z"),
    ];
    const store = new SessionStore(":memory:", () => times.shift()!);
    const session = store.upsertReadySession(target, metadata(), evidence());
    const entry = store.createInvestigationEntry(session.id, {
      stopId: "counter", evidenceId: "counter-file", question: "Can this race?", provider: "codex", model: "gpt-6-sol",
    });
    expect(entry.status).toBe("streaming");
    expect(store.updateInvestigationEntry(session.id, entry.id, "The increment is atomic.", "complete"))
      .toMatchObject({ answer: "The increment is atomic.", status: "complete" });
    expect(store.listInvestigationEntries(session.id)).toHaveLength(1);
    store.close();
  });

  it("persists scope-aware review progress and position", () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata(), evidence());

    store.saveReviewProgress(session.id, "full", "counter", { stopId: "counter", status: "understood" });
    store.saveReviewProgress(session.id, "update", "counter-update", { stopId: "counter-update", status: "flagged" });
    store.saveReviewProgress(session.id, "full", "tests");

    expect(store.getReviewProgress(session.id)).toEqual({
      activeScope: "full",
      activeStopIds: { full: "tests", update: "counter-update" },
      scopes: { full: { counter: "understood" }, update: { "counter-update": "flagged" } },
    });
    store.close();
  });

  it("persists model-context exclusions and invalidates generated tours", () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata(), evidence());
    store.saveTour(session.id, "full", { provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" },
      session.metadata.base.sha, session.metadata.head.sha, {
        summary: "Summary", findingRevisions: [], stops: [{
          id: "counter", title: "Counter", summary: "Counter changes.", purpose: "Review it.",
          anchorIds: ["file"], claims: [{ text: "Changed.", kind: "fact", confidence: "high", anchorIds: ["file"] }], prompts: [],
        }],
      });

    expect(store.saveContextExclusions(session.id, ["vendor/**", "**/*.pem"])).toEqual(["vendor/**", "**/*.pem"]);
    expect(store.getTour(session.id, "full")).toBeUndefined();
    store.close();
  });

  it("finds the latest pull request checkpoint and persists its update evidence", () => {
    const store = new SessionStore(":memory:");
    const baseline = store.upsertReadySession(target, metadata(), evidence());
    store.saveCheckpoint(baseline.id, {
      reviewedHeadSha: baseline.metadata.head.sha,
      completedAt: "2026-09-29T12:10:00Z",
      scope: "full",
      coverage: { counter: "understood" },
      findingRevisions: [],
    });
    const nextMetadata = { ...metadata(), head: { ref: "feature", sha: "c".repeat(40) } };
    const nextEvidence = { ...evidence(), headSha: nextMetadata.head.sha };
    const current = store.upsertReadySession(target, nextMetadata, nextEvidence);
    const updateEvidence = { ...evidence(), baseSha: baseline.metadata.head.sha, headSha: current.metadata.head.sha };

    expect(store.latestCheckpointForPullRequest("openai/codex", 42)).toMatchObject({
      sessionId: baseline.id,
      reviewedHeadSha: baseline.metadata.head.sha,
      coverage: { counter: "understood" },
    });
    expect(store.saveReviewUpdate(current.id, baseline.id, updateEvidence)).toEqual({
      sessionId: current.id,
      baselineSessionId: baseline.id,
      fromHeadSha: baseline.metadata.head.sha,
      toHeadSha: current.metadata.head.sha,
      evidence: updateEvidence,
      createdAt: expect.any(String),
    });
    expect(store.getReviewUpdate(current.id)?.evidence).toEqual(updateEvidence);
    store.close();
  });

  it("uses a portable configurable data location", () => {
    expect(defaultDatabasePath({ WINGDIFF_DATA_DIR: "/secure/wingdiff" }, "linux")).toBe(path.join("/secure/wingdiff", "wingdiff.sqlite3"));
    expect(defaultDatabasePath({ XDG_DATA_HOME: "/data" }, "linux")).toBe(path.join("/data", "wingdiff", "wingdiff.sqlite3"));
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
