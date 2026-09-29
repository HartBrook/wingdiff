import express from "express";
import { acquireReviewSession, refreshReviewSession, type AcquisitionDependencies } from "./acquisition.js";
import { inspectLocalTarget } from "./preflight.js";
import { createProviders, publicProviders, validateSelection } from "./providers/index.js";
import type { ProviderId, TextProvider } from "./providers/types.js";
import { SessionStore } from "./sessions.js";
import type { TourScope } from "./sessions.js";
import { parsePullRequestTarget } from "./targets.js";
import { generateSessionTour, getSessionTour } from "./tourService.js";
import { validateInvestigationContext } from "./validation.js";

export interface AppOptions {
  cwd?: string;
  sessionStore?: SessionStore;
  providers?: Map<ProviderId, TextProvider>;
  acquisitionDependencies?: AcquisitionDependencies;
}

export function createApp(environment: NodeJS.ProcessEnv = process.env, options: AppOptions = {}) {
  const app = express();
  const providers = options.providers ?? createProviders(environment);
  const cwd = options.cwd ?? process.cwd();
  const sessionStore = options.sessionStore ?? new SessionStore();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ service: "wingdiff", status: "ready" });
  });

  app.post("/api/targets/parse", (request, response) => {
    try {
      const target = parsePullRequestTarget(request.body?.input, request.body?.checkoutRepository);
      response.json({ target });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The pull request target is not valid.";
      response.status(400).json({ error: message });
    }
  });

  app.post("/api/targets/prepare", async (request, response) => {
    try {
      const target = parsePullRequestTarget(request.body?.input, request.body?.checkoutRepository);
      const environment = await inspectLocalTarget(target, cwd);
      response.json({ target, environment });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The pull request target could not be prepared.";
      response.status(400).json({ error: message });
    }
  });

  app.get("/api/sessions", (_request, response) => {
    response.json({ sessions: sessionStore.listSessions() });
  });

  app.get("/api/sessions/:id", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    response.json({ session });
  });

  app.post("/api/sessions", async (request, response) => {
    try {
      const target = parsePullRequestTarget(request.body?.input, request.body?.checkoutRepository);
      const session = await acquireReviewSession(target, cwd, sessionStore, undefined, options.acquisitionDependencies);
      response.status(201).json({ session });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not acquire this pull request.";
      response.status(400).json({ error: message });
    }
  });

  app.get("/api/sessions/:id/checkpoint", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    response.json({ checkpoint: sessionStore.latestCheckpoint(session.id) ?? null });
  });

  app.post("/api/sessions/:id/checkpoint", (request, response) => {
    try {
      const session = sessionStore.getSession(request.params.id);
      if (!session) {
        response.status(404).json({ error: "Review session not found." });
        return;
      }
      const coverage = reviewCoverage(request.body?.coverage);
      const findingRevisions = Array.isArray(request.body?.findingRevisions) ? request.body.findingRevisions : [];
      const checkpoint = {
        reviewedHeadSha: session.metadata.head.sha,
        completedAt: new Date().toISOString(),
        coverage,
        findingRevisions,
      };
      sessionStore.saveCheckpoint(session.id, checkpoint);
      response.status(201).json({ checkpoint });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not save this review checkpoint.";
      response.status(400).json({ error: message });
    }
  });

  app.post("/api/sessions/:id/refresh", async (request, response) => {
    try {
      const session = sessionStore.getSession(request.params.id);
      if (!session) {
        response.status(404).json({ error: "Review session not found." });
        return;
      }
      const result = await refreshReviewSession(
        session.target,
        cwd,
        sessionStore,
        undefined,
        options.acquisitionDependencies,
      );
      response.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not check for pull request updates.";
      response.status(400).json({ error: message });
    }
  });

  app.get("/api/sessions/:id/update", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    response.json({ update: sessionStore.getReviewUpdate(session.id) ?? null });
  });

  app.get("/api/sessions/:id/tour", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    let scope: TourScope;
    try {
      scope = tourScope(request.query.scope);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid tour scope." });
      return;
    }
    let generated;
    try {
      generated = getSessionTour(session, sessionStore, scope);
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : "Tour evidence not found." });
      return;
    }
    if (!generated) {
      response.status(404).json({ error: "This revision does not have a generated tour yet." });
      return;
    }
    response.json({ generated });
  });

  app.post("/api/sessions/:id/tour", async (request, response) => {
    try {
      const session = sessionStore.getSession(request.params.id);
      if (!session) {
        response.status(404).json({ error: "Review session not found." });
        return;
      }
      const selection = validateSelection(request.body?.selection);
      const scope = tourScope(request.body?.scope);
      const provider = providers.get(selection.provider);
      if (!provider) {
        const setup = selection.provider === "codex"
          ? "Install Codex CLI and run codex login"
          : `set ${selection.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}`;
        response.status(503).json({
          error: `${selection.provider} is not configured. ${setup} before starting Wingdiff.`,
        });
        return;
      }

      const abortController = new AbortController();
      response.on("close", () => abortController.abort());
      const generated = await generateSessionTour(
        session,
        selection,
        provider,
        sessionStore,
        scope,
        abortController.signal,
      );
      response.status(201).json({ generated });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not generate this tour.";
      response.status(400).json({ error: message });
    }
  });

  app.get("/api/providers", (_request, response) => {
    response.json({ providers: publicProviders(environment, new Set(providers.keys())) });
  });

  app.post("/api/investigate", async (request, response) => {
    try {
      const selection = validateSelection(request.body?.selection);
      const context = validateInvestigationContext(request.body?.context);
      const provider = providers.get(selection.provider);
      if (!provider) {
        const setup = selection.provider === "codex"
          ? "Install Codex CLI and run codex login"
          : `set ${selection.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}`;
        response.status(503).json({
          error: `${selection.provider} is not configured. ${setup} before starting Wingdiff.`,
        });
        return;
      }

      response.status(200);
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders();

      const abortController = new AbortController();
      response.on("close", () => abortController.abort());

      for await (const delta of provider.streamInvestigation(selection, context, abortController.signal)) {
        response.write(`data: ${JSON.stringify({ type: "delta", delta })}\n\n`);
      }
      response.write(`data: ${JSON.stringify({ type: "done", provider: selection.provider, model: selection.model })}\n\n`);
      response.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Investigation failed.";
      if (!response.headersSent) {
        response.status(400).json({ error: message });
      } else {
        response.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
        response.end();
      }
    }
  });

  return app;
}

function reviewCoverage(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Review coverage is required.");
  const coverage: Record<string, string> = {};
  for (const [stopId, status] of Object.entries(input)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stopId)) throw new Error(`Invalid review stop id: ${stopId}`);
    if (!["understood", "flagged", "skipped"].includes(String(status))) {
      throw new Error(`Invalid coverage state for ${stopId}.`);
    }
    coverage[stopId] = String(status);
  }
  if (Object.keys(coverage).length === 0) throw new Error("Review coverage cannot be empty.");
  return coverage;
}

function tourScope(input: unknown): TourScope {
  if (input === undefined || input === null || input === "" || input === "full") return "full";
  if (input === "update") return "update";
  throw new Error(`Invalid tour scope: ${String(input)}`);
}
