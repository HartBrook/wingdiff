import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeGitLabMergeRequestMetadata, publishGitLabMergeRequestReview, readGitLabMergeRequestMetadata, type GitLabCommandRunner } from "./gitlab.js";
import type { DraftReviewComment } from "./sessions.js";
import { parsePullRequestTarget } from "./targets.js";

const target = parsePullRequestTarget("https://gitlab.com/acme/platform/service/-/merge_requests/42");
const baseSha = "a".repeat(40);
const startSha = "b".repeat(40);
const headSha = "c".repeat(40);
const pinned = { headSha, startSha, baseSha };
const mergeRequest = {
  iid: 42,
  web_url: target.canonicalUrl,
  title: "Make retries atomic",
  description: "Use one operation.",
  author: { username: "tanuki", name: "GitLab User" },
  target_branch: "main",
  source_branch: "fix/retries",
  diff_refs: { base_sha: baseSha, start_sha: startSha, head_sha: headSha },
  changes_count: "2",
  state: "opened",
  draft: false,
  updated_at: "2026-10-01T12:30:00Z",
  head_pipeline: { status: "failed" },
};
const commits = [{ id: headSha, title: "Fix retries", authored_date: "2026-10-01T12:00:00Z" }];
const diffs = [
  { old_path: "src/retry.ts", new_path: "src/retry.ts", diff: "@@ -1 +1,2 @@\n-old\n+new\n+again" },
  { old_path: "test/retry.ts", new_path: "test/retry.ts", diff: "@@ -0,0 +1 @@\n+test" },
];

describe("GitLab merge request integration", () => {
  it("reads bounded API resources and normalizes metadata", async () => {
    const calls: string[][] = [];
    const runner: GitLabCommandRunner = async (arguments_) => {
      calls.push(arguments_);
      if (arguments_.includes("version")) return JSON.stringify({ version: "19.2.0-ee" });
      const endpoint = arguments_.find((value) => value.startsWith("projects/")) ?? "";
      if (endpoint.endsWith("/commits?per_page=100")) return ndjson(commits);
      if (endpoint.endsWith("/diffs?per_page=100")) return ndjson(diffs);
      if (endpoint.endsWith("/approvals")) return JSON.stringify({ approved_by: [{ user: { username: "reviewer" } }] });
      return JSON.stringify(mergeRequest);
    };
    const metadata = await readGitLabMergeRequestMetadata(target, "/work/service", runner);

    expect(calls).toHaveLength(5);
    expect(calls[2]).toEqual(expect.arrayContaining(["--paginate", "--output", "ndjson"]));
    expect(calls.every((call) => {
      const hostnameIndex = call.indexOf("--hostname");
      return hostnameIndex >= 0 && call[hostnameIndex + 1] === "gitlab.com";
    })).toBe(true);
    expect(calls[1]).toContain("projects/acme%2Fplatform%2Fservice/merge_requests/42");
    expect(metadata).toMatchObject({
      number: 42,
      repository: "acme/platform/service",
      base: { ref: "main", sha: startSha },
      head: { ref: "fix/retries", sha: headSha },
      additions: 3,
      deletions: 1,
      filesChanged: 2,
      checks: { passed: 0, failed: 1, pending: 0, total: 1 },
      reviews: { count: 1, decision: "APPROVED" },
      state: "OPEN",
    });
  });

  it("rejects a GitLab server without the review-publication API before reading the merge request", async () => {
    const calls: string[][] = [];
    await expect(readGitLabMergeRequestMetadata(target, "/work/service", async (arguments_) => {
      calls.push(arguments_);
      return JSON.stringify({ version: "19.1.9-ee" });
    })).rejects.toThrow(/GitLab 19\.2\.0 or later.*19\.1\.9-ee is not supported/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("version");
  });

  it("counts a pipeline blocked on a manual job as pending", () => {
    const metadata = normalizeGitLabMergeRequestMetadata({ ...mergeRequest, head_pipeline: { status: "manual" } }, commits, diffs, {}, target);
    expect(metadata.checks).toEqual({ passed: 0, failed: 0, pending: 1, total: 1 });
  });

  it("rejects a response for another merge request", () => {
    expect(() => normalizeGitLabMergeRequestMetadata(
      { ...mergeRequest, web_url: "https://gitlab.com/acme/platform/service/-/merge_requests/43" },
      commits,
      diffs,
      {},
      target,
    )).toThrow(/requested acme\/platform\/service!42/);
  });

  it("publishes inline notes together and applies the native disposition", async () => {
    const calls: Array<{ arguments_: string[]; input?: string }> = [];
    const comment = draftComment();
    const result = await publishGitLabMergeRequestReview(
      target,
      "/work/service",
      pinned,
      { body: "Please address the race.", event: "REQUEST_CHANGES" },
      [{ ...comment, oldPath: "src/old-retry.ts" }],
      async (arguments_, _cwd, input) => {
        calls.push({ arguments_, input });
        if (arguments_.some((value) => value.endsWith("/versions"))) {
          return JSON.stringify([{ id: 7, base_commit_sha: baseSha, start_commit_sha: startSha, head_commit_sha: headSha }]);
        }
        if (arguments_.some((value) => value.endsWith("/draft_notes?per_page=100"))) return "[]";
        if (arguments_.some((value) => value.endsWith("/draft_notes"))) return JSON.stringify({ id: 91 });
        return "";
      },
    );

    const note = calls.find((call) => call.arguments_.some((value) => value.endsWith("/draft_notes")))!;
    expect(note.arguments_).toEqual(expect.arrayContaining(["--input", "-", "--header", "Content-Type: application/json"]));
    expect(JSON.parse(note.input!)).toEqual({
      note: "This can race.",
      position: {
        position_type: "text",
        base_sha: baseSha,
        head_sha: headSha,
        start_sha: startSha,
        old_path: "src/old-retry.ts",
        new_path: "src/retry.ts",
        new_line: 3,
        line_range: {
          start: {
            line_code: `${createHash("sha1").update("src/retry.ts").digest("hex")}_0_2`,
            type: "new",
            new_line: 2,
          },
          end: {
            line_code: `${createHash("sha1").update("src/retry.ts").digest("hex")}_0_3`,
            type: "new",
            new_line: 3,
          },
        },
      },
    });
    const publish = calls.find((call) => call.arguments_.some((value) => value.endsWith("/bulk_publish")))!;
    expect(JSON.parse(publish.input!)).toEqual({ note: "Please address the race.", reviewer_state: "requested_changes" });
    expect(result).toEqual({ id: 91, url: target.canonicalUrl, state: "REQUEST_CHANGES" });
  });

  it("refuses to publish when the target branch moved even though the head did not", async () => {
    const calls: Array<{ arguments_: string[]; input?: string }> = [];
    await expect(publishGitLabMergeRequestReview(
      target, "/work/service", { ...pinned, startSha: "d".repeat(40) }, { body: "", event: "COMMENT" }, [draftComment()],
      publishRunner(calls),
    )).rejects.toThrow(/target branch moved from ddddddd to bbbbbbb/);
    await expect(publishGitLabMergeRequestReview(
      target, "/work/service", { ...pinned, baseSha: "e".repeat(40) }, { body: "", event: "COMMENT" }, [draftComment()],
      publishRunner(calls),
    )).rejects.toThrow(/target branch moved/);
    expect(calls.some((call) => call.arguments_.includes("POST"))).toBe(false);
  });

  it("pins GitLab approval to the reviewed head", async () => {
    const calls: Array<{ arguments_: string[]; input?: string }> = [];
    await publishGitLabMergeRequestReview(target, "/work/service", pinned, { body: "Looks good.", event: "APPROVE" }, [], async (arguments_, _cwd, input) => {
      calls.push({ arguments_, input });
      if (arguments_.some((value) => value.endsWith("/versions"))) {
        return JSON.stringify([{ base_commit_sha: baseSha, start_commit_sha: startSha, head_commit_sha: headSha }]);
      }
      if (arguments_.some((value) => value.endsWith("/draft_notes?per_page=100"))) return "[]";
      return "";
    });
    const approval = calls.find((call) => call.arguments_.some((value) => value.endsWith("/approve")))!;
    expect(JSON.parse(approval.input!)).toEqual({ sha: headSha });
  });

  it("sends both line numbers for a single-line comment on an unchanged context line", async () => {
    const calls: Array<{ arguments_: string[]; input?: string }> = [];
    await publishGitLabMergeRequestReview(
      target, "/work/service", pinned, { body: "", event: "COMMENT" },
      [{ ...draftComment(), startLine: 3, endLine: 3, endOldLine: 2, endNewLine: 3 }],
      publishRunner(calls),
    );
    const note = calls.find((call) => call.arguments_.some((value) => value.endsWith("/draft_notes")))!;
    expect(JSON.parse(note.input!).position).toMatchObject({ old_line: 2, new_line: 3 });
  });

  it("refuses to publish while the user has other pending draft notes", async () => {
    const calls: Array<{ arguments_: string[]; input?: string }> = [];
    await expect(publishGitLabMergeRequestReview(
      target, "/work/service", pinned, { body: "", event: "COMMENT" }, [draftComment()],
      publishRunner(calls, { pendingDrafts: [{ id: 5 }] }),
    )).rejects.toThrow(/pending GitLab draft notes/);
    expect(calls.some((call) => call.arguments_.includes("POST"))).toBe(false);
  });

  it("deletes this attempt's draft notes when a later draft note fails", async () => {
    const calls: Array<{ arguments_: string[]; input?: string }> = [];
    await expect(publishGitLabMergeRequestReview(
      target, "/work/service", pinned, { body: "", event: "COMMENT" },
      [draftComment(), { ...draftComment(), id: "comment-2" }],
      publishRunner(calls, { failDraftAfter: 1 }),
    )).rejects.toThrow(/rejected/);
    expect(calls.some((call) => call.arguments_.includes("DELETE") && call.arguments_.some((value) => value.endsWith("/draft_notes/91")))).toBe(true);
    expect(calls.some((call) => call.arguments_.some((value) => value.endsWith("/bulk_publish")))).toBe(false);
  });

  it("deletes this attempt's drafts when the merge request moves before bulk publication", async () => {
    const calls: Array<{ arguments_: string[]; input?: string }> = [];
    let versionReads = 0;
    await expect(publishGitLabMergeRequestReview(
      target, "/work/service", pinned, { body: "Please fix this.", event: "REQUEST_CHANGES" }, [draftComment()],
      async (arguments_, _cwd, input) => {
        calls.push({ arguments_, input });
        if (arguments_.some((value) => value.endsWith("/versions"))) {
          versionReads += 1;
          return JSON.stringify([{
            base_commit_sha: baseSha,
            start_commit_sha: startSha,
            head_commit_sha: versionReads === 1 ? headSha : "d".repeat(40),
          }]);
        }
        if (arguments_.some((value) => value.endsWith("/draft_notes?per_page=100"))) return "[]";
        if (arguments_.includes("POST") && arguments_.some((value) => value.endsWith("/draft_notes"))) {
          return JSON.stringify({ id: 91 });
        }
        return "";
      },
    )).rejects.toThrow(/moved from ccccccc to ddddddd/);
    expect(calls.some((call) => call.arguments_.includes("DELETE") && call.arguments_.some((value) => value.endsWith("/draft_notes/91")))).toBe(true);
    expect(calls.some((call) => call.arguments_.some((value) => value.endsWith("/bulk_publish")))).toBe(false);
  });
});

function ndjson(values: unknown[]): string {
  return values.map((value) => `${JSON.stringify(value)}\n`).join("");
}

function publishRunner(
  calls: Array<{ arguments_: string[]; input?: string }>,
  options: { pendingDrafts?: unknown[]; failDraftAfter?: number } = {},
) {
  let created = 0;
  return async (arguments_: string[], _cwd: string, input?: string): Promise<string> => {
    calls.push({ arguments_, input });
    if (arguments_.some((value) => value.endsWith("/versions"))) {
      return JSON.stringify([{ base_commit_sha: baseSha, start_commit_sha: startSha, head_commit_sha: headSha }]);
    }
    if (arguments_.some((value) => value.endsWith("/draft_notes?per_page=100"))) return JSON.stringify(options.pendingDrafts ?? []);
    if (arguments_.includes("POST") && arguments_.some((value) => value.endsWith("/draft_notes"))) {
      if (options.failDraftAfter !== undefined && created >= options.failDraftAfter) throw new Error("GitLab rejected the draft note.");
      created += 1;
      return JSON.stringify({ id: 90 + created });
    }
    return "";
  };
}

function draftComment(): DraftReviewComment {
  return {
    id: "comment-1", sessionId: "session-1", stopId: "retry", evidenceId: "retry-file",
    path: "src/retry.ts", side: "RIGHT", startLine: 2, endLine: 3, body: "This can race.", severity: "high",
    fingerprint: "new-retry", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z",
  };
}
