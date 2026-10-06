import { describe, expect, it, vi } from "vitest";
import { publishPullRequestReview, submitSessionReview } from "./reviews.js";
import { SessionStore, type DraftReviewComment } from "./sessions.js";
import { parsePullRequestTarget } from "./targets.js";
import type { PullRequestMetadata } from "./github.js";
import { createHash } from "node:crypto";
import { validateDraftComment } from "./comments.js";
import { parseUnifiedDiff, type PullRequestEvidence } from "./diff.js";
import { publishGitLabMergeRequestReview } from "./gitlab.js";

const target = parsePullRequestTarget("https://github.com/openai/codex/pull/42");
const headSha = "b".repeat(40);

describe("GitHub review submission", () => {
  it("sends a line/side batch review as JSON over stdin", async () => {
    const calls: Array<{ arguments_: string[]; input: string }> = [];
    const comment = draftComment();
    const result = await publishPullRequestReview(target, "/work/codex", headSha, { body: "Please address the race.", event: "REQUEST_CHANGES" }, [comment], async (arguments_, _cwd, input) => {
      calls.push({ arguments_, input });
      return JSON.stringify({ id: 91, html_url: "https://github.com/openai/codex/pull/42#pullrequestreview-91", state: "CHANGES_REQUESTED" });
    });

    expect(calls[0]?.arguments_).toContain("repos/openai/codex/pulls/42/reviews");
    expect(JSON.parse(calls[0]!.input)).toEqual({
      commit_id: headSha,
      body: "Please address the race.",
      event: "REQUEST_CHANGES",
      comments: [{ path: "src/counter.ts", body: "This can race.", line: 3, side: "RIGHT", start_line: 2, start_side: "RIGHT" }],
    });
    expect(result.id).toBe(91);
  });

  it("blocks publishing when the pull request head moved", async () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata(), evidence());
    let published = false;
    await expect(submitSessionReview(session, store, "/work/codex", { body: "Looks good.", event: "APPROVE" }, {
      readMetadata: async () => ({ ...metadata(), head: { ref: "feature", sha: "c".repeat(40) } }),
      publishReview: async () => { published = true; return { id: 1, url: "url", state: "APPROVED" }; },
    })).rejects.toThrow(/head changed/);
    expect(published).toBe(false);
    store.close();
  });

  it("blocks GitLab publishing when the target branch moved but the head did not", async () => {
    const gitLabTarget = parsePullRequestTarget("https://gitlab.com/acme/service/-/merge_requests/42");
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(gitLabTarget, metadata(), evidence());
    let published = false;
    await expect(submitSessionReview(session, store, "/work/service", { body: "Looks good.", event: "APPROVE" }, {
      readMetadata: async () => ({ ...metadata(), base: { ref: "main", sha: "d".repeat(40) } }),
      publishReview: async () => { published = true; return { id: 1, url: "url", state: "APPROVED" }; },
    })).rejects.toThrow(/target branch moved from aaaaaaa to ddddddd/);
    expect(published).toBe(false);
    store.close();
  });

  it("passes the pinned GitLab diff refs to publication", async () => {
    const gitLabTarget = parsePullRequestTarget("https://gitlab.com/acme/service/-/merge_requests/42");
    const diffRefs = { baseSha: "e".repeat(40), startSha: "a".repeat(40), headSha };
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(gitLabTarget, { ...metadata(), diffRefs }, evidence());
    let pinned: unknown;
    await submitSessionReview(session, store, "/work/service", { body: "Looks good.", event: "APPROVE" }, {
      readMetadata: async () => ({ ...metadata(), diffRefs }),
      publishReview: async (_target, _cwd, revisions) => { pinned = revisions; return { id: 1, url: "url", state: "APPROVED" }; },
    });
    expect(pinned).toEqual({ headSha, startSha: "a".repeat(40), baseSha: "e".repeat(40) });
    store.close();
  });

  it("builds GitLab line ranges from each endpoint's own line kind and the file's new path", async () => {
    const gitLabTarget = parsePullRequestTarget("https://gitlab.com/acme/service/-/merge_requests/42");
    const renamed = parseUnifiedDiff(`diff --git a/src/old.ts b/src/new.ts
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
`, "a".repeat(40), headSha);
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(gitLabTarget, metadata(), renamed);
    const lines = renamed.files[0]!.hunks[0]!.lines;
    const comment = (side: "LEFT" | "RIGHT", startLine: number, endLine: number) => validateDraftComment({
      stopId: "rename", evidenceId: "rename-file", path: "src/new.ts", side, startLine, endLine, body: `${side} range`, severity: "low",
      fingerprint: lines.find((line) => (side === "RIGHT" ? line.newLine : line.oldLine) === endLine)!.fingerprint,
    }, renamed);
    store.saveDraftComment(session.id, comment("RIGHT", 1, 3));
    store.saveDraftComment(session.id, comment("LEFT", 1, 2));

    const notes: Array<{ note: string; position: { line_range: unknown } }> = [];
    await submitSessionReview(session, store, "/work/service", { body: "Ranges.", event: "COMMENT" }, {
      readMetadata: async () => metadata(),
      publishReview: (reviewTarget, cwd, pinned, draft, comments) => publishGitLabMergeRequestReview(reviewTarget, cwd, pinned, draft, comments, async (arguments_, _cwd, input) => {
        if (arguments_.some((value) => value.endsWith("/versions"))) {
          return JSON.stringify([{ base_commit_sha: "a".repeat(40), start_commit_sha: "a".repeat(40), head_commit_sha: headSha }]);
        }
        if (arguments_.some((value) => value.endsWith("/draft_notes?per_page=100"))) return "[]";
        if (arguments_.some((value) => value.endsWith("/draft_notes"))) {
          notes.push(JSON.parse(input!));
          return JSON.stringify({ id: notes.length });
        }
        return "";
      }),
    });

    const pathHash = createHash("sha1").update("src/new.ts").digest("hex");
    expect(notes.find((note) => note.note === "RIGHT range")!.position.line_range).toEqual({
      start: { line_code: `${pathHash}_1_1`, type: "old", old_line: 1, new_line: 1 },
      end: { line_code: `${pathHash}_3_3`, type: "new", new_line: 3 },
    });
    expect(notes.find((note) => note.note === "LEFT range")!.position.line_range).toEqual({
      start: { line_code: `${pathHash}_1_1`, type: "old", old_line: 1, new_line: 1 },
      end: { line_code: `${pathHash}_2_2`, type: "old", old_line: 2 },
    });
    store.close();
  });

  it("records a submission and prevents duplicate publication", async () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata(), evidence());
    let publishCount = 0;
    const dependencies = {
      readMetadata: async () => metadata(),
      publishReview: async () => {
        publishCount += 1;
        return { id: 91, url: "https://github.com/openai/codex/pull/42#pullrequestreview-91", state: "APPROVED" };
      },
    };

    const submitted = await submitSessionReview(session, store, "/work/codex", { body: "Looks good.", event: "APPROVE" }, dependencies);
    expect(submitted).toMatchObject({ githubReviewId: 91, headSha, event: "APPROVE" });
    await expect(submitSessionReview(session, store, "/work/codex", { body: "Again.", event: "APPROVE" }, dependencies))
      .rejects.toThrow(/already been published/);
    expect(publishCount).toBe(1);
    store.close();
  });

  it("requires explicit acknowledgement before approving unresolved review signals", async () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata(), evidence());
    store.saveTour(session.id, "full", { provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" },
      session.evidence.baseSha, session.evidence.headSha, {
        summary: "The change needs review.",
        findingRevisions: [],
        stops: [{
          id: "risky-stop", title: "Risky behavior", summary: "A boundary changed.", purpose: "Verify the boundary.",
          anchorIds: ["file-risk"],
          claims: [{ text: "The boundary changed.", kind: "fact", confidence: "high", anchorIds: ["file-risk"] }],
          prompts: [],
          finding: {
            title: "Failure is unhandled", body: "The new failure path is not handled.", severity: "high",
            category: "Correctness", anchorIds: ["file-risk"], suggestedComment: "How is this failure handled?",
          },
        }],
      });
    let published = false;
    const dependencies = {
      readMetadata: async () => metadata(),
      publishReview: async () => { published = true; return { id: 92, url: "url", state: "APPROVED" }; },
    };

    await expect(submitSessionReview(
      session,
      store,
      "/work/codex",
      { body: "Looks good.", event: "APPROVE" },
      dependencies,
      { scope: "full", acknowledgeApprovalRisks: false },
    )).rejects.toThrow(/explicit acknowledgement/);
    expect(published).toBe(false);

    await expect(submitSessionReview(
      session,
      store,
      "/work/codex",
      { body: "Looks good.", event: "APPROVE" },
      dependencies,
      { scope: "full", acknowledgeApprovalRisks: true },
    )).resolves.toMatchObject({ githubReviewId: 92 });
    store.close();
  });

  it("serializes concurrent publications and preserves ambiguous outcomes", async () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata(), evidence());
    let finishPublication!: (value: { id: number; url: string; state: string }) => void;
    let publishCount = 0;
    const dependencies = {
      readMetadata: async () => metadata(),
      publishReview: async () => {
        publishCount += 1;
        return new Promise<{ id: number; url: string; state: string }>((resolve) => { finishPublication = resolve; });
      },
    };
    const first = submitSessionReview(session, store, "/work/codex", { body: "Review.", event: "COMMENT" }, dependencies);
    await vi.waitFor(() => expect(publishCount).toBe(1));

    await expect(submitSessionReview(session, store, "/work/codex", { body: "Review.", event: "COMMENT" }, dependencies))
      .rejects.toThrow(/already in progress/);
    expect(publishCount).toBe(1);
    finishPublication({ id: 93, url: "url", state: "COMMENTED" });
    await expect(first).resolves.toMatchObject({ githubReviewId: 93 });
    expect(store.getReviewPublication(session.id, session.metadata.head.sha)).toBeUndefined();
    store.close();
  });

  it("blocks retries after an ambiguous GitHub failure until the reviewer clears it", async () => {
    const store = new SessionStore(":memory:");
    const session = store.upsertReadySession(target, metadata(), evidence());
    let shouldFail = true;
    let publishCount = 0;
    const dependencies = {
      readMetadata: async () => metadata(),
      publishReview: async () => {
        publishCount += 1;
        if (shouldFail) throw new Error("connection closed after upload");
        return { id: 94, url: "url", state: "COMMENTED" };
      },
    };

    await expect(submitSessionReview(session, store, "/work/codex", { body: "Review.", event: "COMMENT" }, dependencies))
      .rejects.toThrow(/outcome is uncertain/);
    expect(store.getReviewPublication(session.id, session.metadata.head.sha)).toMatchObject({
      state: "uncertain",
      error: "connection closed after upload",
    });
    await expect(submitSessionReview(session, store, "/work/codex", { body: "Review.", event: "COMMENT" }, dependencies))
      .rejects.toThrow(/uncertain outcome/);
    expect(publishCount).toBe(1);

    expect(store.clearUncertainReviewPublication(session.id, session.metadata.head.sha)).toBe(true);
    shouldFail = false;
    await expect(submitSessionReview(session, store, "/work/codex", { body: "Review.", event: "COMMENT" }, dependencies))
      .resolves.toMatchObject({ githubReviewId: 94 });
    store.close();
  });
});

function draftComment(): DraftReviewComment {
  return {
    id: "comment-1", sessionId: "session-1", stopId: "counter", evidenceId: "counter-file",
    path: "src/counter.ts", side: "RIGHT", startLine: 2, endLine: 3, body: "This can race.", severity: "high",
    fingerprint: "new-counter", createdAt: "2026-09-29T12:00:00Z", updatedAt: "2026-09-29T12:00:00Z",
  };
}

function metadata(): PullRequestMetadata {
  return {
    number: 42, repository: "openai/codex", url: target.canonicalUrl, title: "Counter", body: "",
    author: { login: "octocat" }, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature", sha: headSha },
    additions: 1, deletions: 1, filesChanged: 1, commits: [], checks: { passed: 0, failed: 0, pending: 0, total: 0 },
    reviews: { count: 0 }, state: "OPEN", draft: false, updatedAt: "2026-09-29T12:00:00Z",
  };
}

function evidence(): PullRequestEvidence {
  return { baseSha: "a".repeat(40), headSha, additions: 0, deletions: 0, files: [] };
}
