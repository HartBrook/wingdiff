import { expect, test, type Page, type Route } from "@playwright/test";

test("reviews a real-session fixture from privacy preview through an anchored draft", async ({ page }) => {
  await mockReviewApi(page);
  await page.goto("/?session=pilot-session");

  await expect(page.getByRole("heading", { name: "Make the counter update atomic" })).toBeVisible();
  await page.getByRole("button", { name: /Generate guided review/ }).click();

  const contextDialog = page.getByRole("dialog", { name: "Model context preview" });
  await expect(contextDialog).toBeVisible();
  await expect(contextDialog.getByText("Codex CLI · GPT-6 Sol", { exact: true })).toBeVisible();
  await expect(contextDialog.getByText("1 sent · 0 excluded")).toBeVisible();
  await contextDialog.getByText("Exact context preview").click();
  await expect(contextDialog.getByText("return redis.incr(key)")).toBeVisible();
  await contextDialog.getByRole("button", { name: "Generate with this context" }).click();

  await expect(page.getByText("No findings currently block approval")).toBeVisible();
  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByRole("heading", { name: "Counter updates become atomic" })).toBeVisible();

  await page.getByRole("button", { name: "Ask", exact: true }).first().click();
  await page.getByLabel("Ask about this change").fill("Can concurrent callers lose increments?");
  await page.getByRole("button", { name: "Ask question" }).click();
  await expect(page.getByText("Redis INCR is atomic for concurrent callers.")).toBeVisible();
  await page.getByRole("button", { name: "Use as comment" }).click();

  const commentDialog = page.getByRole("dialog");
  await expect(commentDialog.getByText("Code context")).toBeVisible();
  await expect(commentDialog.getByRole("textbox", { name: "Comment" })).toHaveValue("Redis INCR is atomic for concurrent callers.");
  await expect(commentDialog.getByText("return redis.incr(key)")).toBeVisible();
  await commentDialog.getByRole("button", { name: "Add to review" }).click();
  await expect(page.getByRole("button", { name: /Review 1/ })).toBeVisible();

  await page.getByRole("button", { name: "New review" }).click();
  await expect(page.getByRole("heading", { name: "Paste a pull request." })).toBeVisible();
});

async function mockReviewApi(page: Page) {
  let tourReady = false;
  let investigationId = "investigation-1";
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/providers") return json(route, { providers });
    if (path === "/api/sessions/pilot-session") return json(route, { session });
    if (path === "/api/sessions/pilot-session/update") return json(route, { update: null, baselineCheckpoint: null });
    if (path === "/api/sessions/pilot-session/progress") {
      return json(route, { progress: { activeScope: null, activeStopIds: { full: null, update: null }, scopes: { full: {}, update: {} } } });
    }
    if (path === "/api/sessions/pilot-session/comments") {
      if (method === "POST") return json(route, { comment: { id: "comment-1", sessionId: session.id, createdAt: now, updatedAt: now, ...request.postDataJSON() } }, 201);
      return json(route, { comments: [] });
    }
    if (path === "/api/sessions/pilot-session/investigations") {
      if (method === "POST") {
        const input = request.postDataJSON();
        return json(route, { entry: { id: investigationId, sessionId: session.id, answer: "", status: "streaming", createdAt: now, updatedAt: now, ...input } }, 201);
      }
      return json(route, { entries: [] });
    }
    if (path === `/api/sessions/pilot-session/investigations/${investigationId}`) {
      const update = request.postDataJSON();
      return json(route, { entry: { id: investigationId, sessionId: session.id, stopId: "atomic-counter", evidenceId: "session-0-src/counter.ts", question: "Can concurrent callers lose increments?", provider: "codex", model: "Codex CLI · GPT-6 Sol", createdAt: now, updatedAt: now, ...update } });
    }
    if (path === "/api/sessions/pilot-session/review-draft") return json(route, { draft: null });
    if (path === "/api/sessions/pilot-session/review-submission") return json(route, { submission: null });
    if (path === "/api/sessions/pilot-session/checkpoint") return json(route, { checkpoint: null });
    if (path === "/api/sessions/pilot-session/context") return json(route, { manifest });
    if (path === "/api/sessions/pilot-session/tour") {
      if (method === "POST") {
        tourReady = true;
        return json(route, { generated: tour }, 201);
      }
      if (url.searchParams.get("scope") === "update" || !tourReady) return json(route, { error: "This revision does not have a generated tour yet." }, 404);
      return json(route, { generated: tour });
    }
    if (path === "/api/investigate") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "delta", delta: "Redis INCR is atomic for concurrent callers." })}\n\ndata: ${JSON.stringify({ type: "done", provider: "codex", model: "gpt-6-sol" })}\n\n`,
      });
    }
    return json(route, { error: `Unhandled test route: ${method} ${path}` }, 500);
  });
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

const now = "2026-09-29T12:00:00.000Z";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const diffLines = [
  { kind: "deletion", content: "return value + 1", oldLine: 2, fingerprint: "old-counter" },
  { kind: "addition", content: "return redis.incr(key)", newLine: 2, fingerprint: "new-counter" },
];
const session = {
  id: "pilot-session",
  target: { owner: "acme", repository: "service", number: 42, canonicalUrl: "https://github.com/acme/service/pull/42", label: "acme/service#42", source: "url" },
  metadata: {
    number: 42, repository: "acme/service", url: "https://github.com/acme/service/pull/42", title: "Make the counter update atomic", body: "Replace a read/write pair.",
    author: { login: "dev" }, base: { ref: "main", sha: baseSha }, head: { ref: "atomic-counter", sha: headSha },
    additions: 1, deletions: 1, filesChanged: 1, commits: [], checks: { passed: 3, failed: 0, pending: 0, total: 3 }, reviews: { count: 0 }, state: "OPEN", draft: false, updatedAt: now,
  },
  evidence: { baseSha, headSha, additions: 1, deletions: 1, files: [{ oldPath: "src/counter.ts", path: "src/counter.ts", status: "modified", additions: 1, deletions: 1, hunks: [{ header: "@@ -2 +2 @@", oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: diffLines }] }] },
  status: "ready", createdAt: now, updatedAt: now,
};
const tour = {
  sessionId: session.id, scope: "full", selection: { provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" }, baseSha, headSha, createdAt: now, updatedAt: now,
  tour: { summary: "The counter now uses one atomic Redis operation.", findingRevisions: [], stops: [{ id: "atomic-counter", title: "Counter updates become atomic", summary: "One Redis operation replaces the read/write pair.", purpose: "Verify concurrent behavior.", anchorIds: ["file-counter", "line_new-counter"], claims: [{ text: "The new path calls Redis INCR.", kind: "fact", confidence: "high", anchorIds: ["line_new-counter"] }], prompts: ["Can concurrent callers lose increments?"] }] },
  anchors: [{ id: "file-counter", path: "src/counter.ts", kind: "file" }, ...diffLines.map((line) => ({ id: `line_${line.fingerprint}`, path: "src/counter.ts", kind: line.kind, content: line.content, ...(line.oldLine ? { oldLine: line.oldLine } : {}), ...(line.newLine ? { newLine: line.newLine } : {}) }))],
};
const manifest = {
  scope: "full", baseSha, headSha, excludedPatterns: ["**/.env*", "**/*.pem", "**/*.key"],
  files: [{ path: "src/counter.ts", included: true, classifications: [], additions: 1, deletions: 1, characters: 42 }],
  instructions: [{ path: "AGENTS.md", content: "Keep reviews concise.", characters: 21, truncated: false }],
  includedFiles: 1, excludedFiles: 0, characters: 612, warnings: [], ready: true,
  promptPreview: "FILE src/counter.ts\nline_new-counter\tnew:2\t+return redis.incr(key)", fingerprint: "c".repeat(64),
};
const providers = [{
  id: "codex", name: "Codex CLI", configured: true, transport: "cli", setupCommand: "codex login", setupDescription: "Sign in.",
  models: [{ id: "gpt-6-sol", provider: "codex", name: "GPT-6 Sol", family: "OpenAI", description: "Balanced review.", badge: "Recommended", reasoningEfforts: ["medium"], defaultEffort: "medium" }],
}];
