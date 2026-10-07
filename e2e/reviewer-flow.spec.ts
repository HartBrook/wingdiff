import { expect, test, type Page, type Route } from "@playwright/test";

test("reviews a real-session fixture from privacy preview through an anchored draft", async ({ page }) => {
  await mockReviewApi(page);
  await page.goto("/?session=pilot-session");

  await expect(page.getByRole("heading", { name: "Make the counter update atomic" })).toBeVisible();
  await page.getByRole("button", { name: /Generate guided review/ }).click();

  const contextDialog = page.getByRole("dialog", { name: "Model context preview" });
  await expect(contextDialog).toBeVisible();
  await expect(contextDialog.getByText("Codex CLI · Account default", { exact: true })).toBeVisible();
  await expect(contextDialog.getByText("1 sent · 0 excluded")).toBeVisible();
  await contextDialog.getByText("Exact context preview").click();
  await expect(contextDialog.getByText("return redis.incr(key)")).toBeVisible();
  await contextDialog.getByRole("button", { name: "Generate with this context" }).click();

  await expect(page.getByText(/elapsed · 10m 0s limit · status checked every second/)).toBeVisible();
  await expect(page.getByText("No findings currently block approval")).toBeVisible();
  await expect(page.locator(".summary-context li")).toHaveText(["Preserve expiry", "Add regression coverage"]);
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

  await page.getByRole("button", { name: /Review 1/ }).click();
  await expect(page.getByRole("heading", { name: "Prepare your decision." })).toBeVisible();
  await page.getByPlaceholder("Summarize your review…").fill("The atomic update is ready.");
  await page.getByRole("button", { name: /Approve Signal/ }).click();
  await expect(page.getByText("Approval needs acknowledgement")).toBeVisible();
  const publish = page.getByRole("button", { name: "Publish review to GitHub" });
  await expect(publish).toBeDisabled();
  await page.getByLabel("I reviewed these signals and still intend to approve.").check();
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(page.getByRole("link", { name: "Open on GitHub" })).toBeVisible();

  await page.getByRole("button", { name: "New review" }).click();
  await expect(page.getByRole("heading", { name: "Choose a pull request." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check setup" })).toBeVisible();
});

test("returns to the top when marking a stop understood", async ({ page }) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Review updates" }).click();

  const canvas = page.locator("main.main-canvas");
  await canvas.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  expect(await canvas.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const firstTitle = await page.locator(".stop-header h1").textContent();
  await page.getByRole("button", { name: "Mark understood", exact: true }).click();
  await expect(page.locator(".stop-header h1")).not.toHaveText(firstTitle ?? "");
  await expect.poll(() => canvas.evaluate((element) => element.scrollTop)).toBe(0);
});

test("publishes on the first click after editing and keeps failures actionable", async ({ page }) => {
  await mockReviewApi(page, { failFirstPublish: true });
  await page.goto("/?session=pilot-session");
  await expect(page.getByRole("heading", { name: "Make the counter update atomic" })).toBeVisible();

  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByPlaceholder("Summarize your review…").fill("The atomic update is ready.");
  const publish = page.getByRole("button", { name: "Publish review to GitHub" });
  await publish.click();

  const failure = page.getByRole("alert").filter({ hasText: "Review not published" });
  await expect(failure).toContainText("GitHub rejected the review.");
  await expect(publish).toBeEnabled();

  await publish.click();
  await expect(page.getByRole("link", { name: "Open on GitHub" })).toBeVisible();
});

async function mockReviewApi(page: Page, options: { failFirstPublish?: boolean } = {}) {
  let tourReady = false;
  let generationStarted = false;
  let generationPolls = 0;
  let investigationId = "investigation-1";
  let publishAttempts = 0;
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
    if (path === "/api/sessions/pilot-session/review-draft") {
      if (method === "PUT") return json(route, { draft: { sessionId: session.id, updatedAt: now, ...request.postDataJSON() } });
      return json(route, { draft: null });
    }
    if (path === "/api/sessions/pilot-session/review-submission") {
      if (method === "POST") {
        publishAttempts += 1;
        if (options.failFirstPublish && publishAttempts === 1) return json(route, { error: "GitHub rejected the review." }, 400);
        const input = request.postDataJSON();
        return json(route, { submission: {
          sessionId: session.id, headSha, githubReviewId: 91, url: "https://github.com/acme/service/pull/42#pullrequestreview-91",
          event: input.event, body: input.body, comments: [], submittedAt: now,
        } }, 201);
      }
      return json(route, { submission: null });
    }
    if (path === "/api/sessions/pilot-session/review-publication") return json(route, { publication: null });
    if (path === "/api/sessions/pilot-session/checkpoint") return json(route, { checkpoint: null });
    if (path === "/api/sessions/pilot-session/context") return json(route, { manifest });
    if (path === "/api/sessions/pilot-session/tour-status") {
      if (!generationStarted) return json(route, { generation: { state: "idle", elapsedMs: 0 } });
      generationPolls += 1;
      if (generationPolls === 1) {
        return json(route, { generation: { state: "running", scope: "full", startedAt: now, elapsedMs: 65_000, timeoutMs: 600_000 } });
      }
      tourReady = true;
      return json(route, { generation: { state: "succeeded", scope: "full", startedAt: now, finishedAt: now, elapsedMs: 1_250, timeoutMs: 600_000 } });
    }
    if (path === "/api/sessions/pilot-session/tour") {
      if (method === "POST") {
        generationStarted = true;
        return json(route, { generation: { state: "running", scope: "full", startedAt: now, elapsedMs: 0, timeoutMs: 600_000 } }, 202);
      }
      if (url.searchParams.get("scope") === "update" || !tourReady) return json(route, { error: "This revision does not have a generated tour yet." }, 404);
      return json(route, { generated: tour });
    }
    if (path === "/api/sessions/pilot-session/investigate") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "delta", delta: "Redis INCR is atomic for concurrent callers." })}\n\ndata: ${JSON.stringify({ type: "done", provider: "codex", model: "codex-default" })}\n\n`,
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
    number: 42, repository: "acme/service", url: "https://github.com/acme/service/pull/42", title: "Make the counter update atomic", body: "Replace a read/write pair.\n\n- Preserve expiry\n- Add regression coverage",
    author: { login: "dev" }, base: { ref: "main", sha: baseSha }, head: { ref: "atomic-counter", sha: headSha },
    additions: 1, deletions: 1, filesChanged: 1, commits: [], checks: { passed: 3, failed: 0, pending: 0, total: 3 }, reviews: { count: 0 }, state: "OPEN", draft: false, updatedAt: now,
  },
  evidence: { baseSha, headSha, additions: 1, deletions: 1, files: [{ oldPath: "src/counter.ts", path: "src/counter.ts", status: "modified", additions: 1, deletions: 1, hunks: [{ header: "@@ -2 +2 @@", oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: diffLines }] }] },
  status: "ready", createdAt: now, updatedAt: now,
};
const tour = {
  sessionId: session.id, scope: "full", selection: { provider: "codex", model: "codex-default", reasoningEffort: "medium" }, baseSha, headSha, createdAt: now, updatedAt: now,
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
  models: [{ id: "codex-default", provider: "codex", name: "Account default", family: "Codex", description: "Uses the signed-in account default.", badge: "Recommended", reasoningEfforts: ["medium"], defaultEffort: "medium" }],
}];
