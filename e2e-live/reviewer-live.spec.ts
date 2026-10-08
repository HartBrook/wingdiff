import { execFile as execFileCallback } from "node:child_process";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";

const execFile = promisify(execFileCallback);
const checkout = path.resolve(process.env.WINGDIFF_LIVE_CHECKOUT ?? process.cwd());

let dataDirectory = "";
let target = "";
let sessionId = "";
let running: { server: Server; url: string; authToken: string } | undefined;

test.describe.serial("local live review", () => {
  test.beforeAll(async () => {
    if (process.env.CI) throw new Error("Live account tests are local-only and must never run in CI.");
    await requireLogin("gh", ["auth", "status", "--hostname", "github.com"], "GitHub CLI is not authenticated. Run: gh auth login");

    target = process.env.WINGDIFF_LIVE_PR?.trim() || await currentPullRequest();
    dataDirectory = await mkdtemp(path.join(tmpdir(), "wingdiff-live-e2e-"));

    const { loadWingdiffEnvironment } = await import("../apps/server/dist/environment.js");
    const { startWingdiffServer } = await import("../apps/server/dist/server.js");
    loadWingdiffEnvironment();
    const environment = {
      ...process.env,
      NODE_ENV: "production",
      WINGDIFF_DATA_DIR: dataDirectory,
      WINGDIFF_PORT: "0",
    };
    running = await startWingdiffServer({ cwd: checkout, development: false, environment, port: 0 });
  });

  test.afterAll(async () => {
    if (running) await closeServer(running.server);
    if (!dataDirectory) return;
    if (process.env.WINGDIFF_LIVE_KEEP_DATA === "1") {
      process.stdout.write(`Kept live-test data at ${dataDirectory}\n`);
      return;
    }
    await rm(dataDirectory, { recursive: true, force: true });
  });

  test("@live-acquire acquires and renders the current pull request", async ({ page }) => {
    test.setTimeout(3 * 60_000);
    await openReview(page);

    await expect(page.locator(".model-button")).toContainText("Codex CLI");
    await expect(page.locator(".model-button")).toContainText("Account default");
    await expect(page.getByRole("button", { name: "Generate guided review" })).toBeVisible();
    await expect(page.getByText(/changed files? passed anchor validation/i)).toBeVisible();
  });

  test("@live-generate generates and opens a grounded guided review", async ({ page }) => {
    test.setTimeout(12 * 60_000);
    await requireLogin(process.env.WINGDIFF_CODEX_BIN || "codex", ["login", "status"], "Codex CLI is not authenticated. Run: codex login");
    await openReview(page);

    await page.getByRole("button", { name: "Generate guided review" }).click();
    const context = page.getByRole("dialog", { name: "Model context preview" });
    await expect(context).toContainText("Codex CLI · Account default");
    await expect(context).toContainText(/\d+ sent · \d+ excluded/i);
    await context.getByRole("button", { name: "Generate with this context" }).click();

    await waitForButtonOrError(page, "Start review", 11 * 60_000);
    await expect(page.getByText(/\d+ review stops?/i)).toBeVisible();
    await page.getByRole("button", { name: "Start review" }).click();
    await expect(page.locator(".stop-header h1")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Review route" })).toBeVisible();
  });
});

async function openReview(page: Page) {
  if (sessionId) {
    await page.goto(authorizedUrl({ session: sessionId }));
    await waitForButtonOrError(page, "Generate guided review", 60_000);
    return;
  }

  await page.goto(authorizedUrl({ target }));
  await waitForButtonOrError(page, "Start review", 60_000);
  await page.getByRole("button", { name: "Start review" }).click();
  await waitForButtonOrError(page, "Generate guided review", 2 * 60_000);
  sessionId = new URL(page.url()).searchParams.get("session") ?? "";
  if (!sessionId) throw new Error("Wingdiff acquired the pull request without opening a persisted review session.");
}

function authorizedUrl(parameters: { target?: string; session?: string }) {
  if (!running) throw new Error("The live Wingdiff server did not start.");
  const url = new URL(running.url);
  if (parameters.target) url.searchParams.set("target", parameters.target);
  if (parameters.session) url.searchParams.set("session", parameters.session);
  url.searchParams.set("wingdiff_token", running.authToken);
  return url.toString();
}

async function waitForButtonOrError(page: Page, buttonName: string, timeout: number) {
  const outcome = await Promise.race([
    page.getByRole("button", { name: buttonName, exact: true }).waitFor({ state: "visible", timeout }).then(() => ({ kind: "ready" as const })),
    page.getByRole("alert").first().waitFor({ state: "visible", timeout }).then(async () => ({
      kind: "error" as const,
      message: (await page.getByRole("alert").first().innerText()).trim(),
    })),
  ]);
  if (outcome.kind === "error") throw new Error(`Wingdiff live flow failed: ${outcome.message}`);
}

async function requireLogin(command: string, arguments_: string[], setupMessage: string) {
  try {
    await execFile(command, arguments_, { cwd: checkout, timeout: 10_000 });
  } catch {
    throw new Error(setupMessage);
  }
}

async function currentPullRequest() {
  try {
    const { stdout } = await execFile("gh", ["pr", "view", "--json", "url", "--jq", ".url"], { cwd: checkout, timeout: 30_000 });
    const url = stdout.trim();
    if (url) return url;
  } catch {
    // Fall through to the actionable error below.
  }
  throw new Error("No pull request is associated with the current branch. Set WINGDIFF_LIVE_PR to a pull request URL.");
}

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
