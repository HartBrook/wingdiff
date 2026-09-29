import express from "express";
import { acquireReviewSession } from "./acquisition.js";
import { inspectLocalTarget } from "./preflight.js";
import { createProviders, publicProviders, validateSelection } from "./providers/index.js";
import { SessionStore } from "./sessions.js";
import { parsePullRequestTarget } from "./targets.js";
import { validateInvestigationContext } from "./validation.js";

export interface AppOptions {
  cwd?: string;
  sessionStore?: SessionStore;
}

export function createApp(environment: NodeJS.ProcessEnv = process.env, options: AppOptions = {}) {
  const app = express();
  const providers = createProviders(environment);
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
      const session = await acquireReviewSession(target, cwd, sessionStore);
      response.status(201).json({ session });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not acquire this pull request.";
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
