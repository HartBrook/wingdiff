import express from "express";
import { createProviders, publicProviders, validateSelection } from "./providers/index.js";
import { validateInvestigationContext } from "./validation.js";

export function createApp(environment: NodeJS.ProcessEnv = process.env) {
  const app = express();
  const providers = createProviders(environment);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

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
