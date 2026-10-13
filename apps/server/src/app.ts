import { timingSafeEqual } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import { acquireReviewSession, refreshReviewSession, type AcquisitionDependencies } from "./acquisition.js";
import { validateDraftComment } from "./comments.js";
import { buildSessionGenerationContext } from "./context.js";
import { buildSessionInvestigationContext } from "./investigation.js";
import { createProviders, publicProviders, validateSelection } from "./providers/index.js";
import type { ModelSelection, ProviderId, TextProvider } from "./providers/types.js";
import { SessionStore } from "./sessions.js";
import type { InvestigationEntry, ReviewDraft, ReviewProgressStatus, TourScope } from "./sessions.js";
import { codeHostName, parsePullRequestTarget } from "./targets.js";
import { generateSessionTour, getSessionTour } from "./tourService.js";
import { validateInvestigationContext } from "./validation.js";
import { submitSessionReview, type ReviewSubmissionDependencies } from "./reviews.js";
import { checkpointCoverageForSession, checkpointFindingsForSession, validateCurrentTourStop } from "./reviewWorkflow.js";
import { prepareRepositoryTarget, resolveRepositoryTarget, type RepositoryResolutionDependencies } from "./repositories.js";

export interface AppOptions {
  cwd?: string;
  development?: boolean;
  sessionStore?: SessionStore;
  providers?: Map<ProviderId, TextProvider>;
  acquisitionDependencies?: AcquisitionDependencies;
  repositoryDependencies?: RepositoryResolutionDependencies;
  reviewSubmissionDependencies?: ReviewSubmissionDependencies;
  authToken?: string;
}

type TourGenerationState = "running" | "succeeded" | "failed";

interface TourGenerationJob {
  state: TourGenerationState;
  scope: TourScope;
  selection: ModelSelection;
  startedAt: number;
  finishedAt?: number;
  timeoutMs?: number;
  error?: string;
  abortController: AbortController;
}

export function createApp(environment: NodeJS.ProcessEnv = process.env, options: AppOptions = {}) {
  const app = express();
  const providers = options.providers ?? createProviders(environment);
  const cwd = options.cwd ?? process.cwd();
  const sessionStore = options.sessionStore ?? new SessionStore();
  const tourGenerations = new Map<string, TourGenerationJob>();
  app.locals.cancelTourGenerations = () => {
    for (const job of tourGenerations.values()) {
      if (job.state === "running") job.abortController.abort();
    }
  };
  const repositoryPathFor = (session: { target: ReturnType<typeof parsePullRequestTarget>; repositoryPath?: string }) => (
    session.repositoryPath
      ? Promise.resolve(session.repositoryPath)
      : resolveRepositoryTarget(session.target, cwd, environment, options.repositoryDependencies)
  );

  app.disable("x-powered-by");
  app.use(securityHeaders(options.development ?? environment.NODE_ENV === "development"));
  app.use(express.json({ limit: "256kb" }));
  if (options.authToken) app.use(localAuthentication(options.authToken));

  app.get("/api/health", (_request, response) => {
    response.json({ service: "wingdiff", status: "ready" });
  });

  app.post("/api/targets/parse", (request, response) => {
    try {
      const target = parsePullRequestTarget(request.body?.input, request.body?.checkoutRepository);
      response.json({ target });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The review target is not valid.";
      response.status(400).json({ error: message });
    }
  });

  app.post("/api/targets/prepare", async (request, response) => {
    try {
      const target = parsePullRequestTarget(request.body?.input, request.body?.checkoutRepository);
      const preparation = await prepareRepositoryTarget(target, cwd, environment, options.repositoryDependencies);
      response.json({ target, environment: preparation });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The review target could not be prepared.";
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
      const repositoryPath = await resolveRepositoryTarget(target, cwd, environment, options.repositoryDependencies);
      const session = await acquireReviewSession(target, repositoryPath, sessionStore, undefined, options.acquisitionDependencies);
      response.status(201).json({ session });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not acquire this review request.";
      response.status(400).json({ error: message });
    }
  });

  app.get("/api/sessions/:id/checkpoint", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    try {
      const scope = request.query.scope === undefined ? undefined : tourScope(request.query.scope);
      response.json({ checkpoint: sessionStore.latestCheckpoint(session.id, scope) ?? null });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid checkpoint scope." });
    }
  });

  app.post("/api/sessions/:id/checkpoint", (request, response) => {
    try {
      const session = sessionStore.getSession(request.params.id);
      if (!session) {
        response.status(404).json({ error: "Review session not found." });
        return;
      }
      const scope = tourScope(request.body?.scope);
      const coverage = checkpointCoverageForSession(session, sessionStore, scope, reviewCoverage(request.body?.coverage));
      const findingRevisions = checkpointFindingsForSession(session, sessionStore, scope);
      const checkpoint = {
        reviewedHeadSha: session.metadata.head.sha,
        completedAt: new Date().toISOString(),
        scope,
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

  app.get("/api/sessions/:id/progress", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    response.json({ progress: sessionStore.getReviewProgress(session.id) });
  });

  app.put("/api/sessions/:id/progress", (request, response) => {
    try {
      const session = sessionStore.getSession(request.params.id);
      if (!session) {
        response.status(404).json({ error: "Review session not found." });
        return;
      }
      const input = reviewProgressInput(request.body);
      validateCurrentTourStop(session, sessionStore, input.scope, input.activeStopId);
      if (input.change) validateCurrentTourStop(session, sessionStore, input.scope, input.change.stopId);
      response.json({ progress: sessionStore.saveReviewProgress(session.id, input.scope, input.activeStopId, input.change) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not save review progress.";
      response.status(400).json({ error: message });
    }
  });

  app.get("/api/sessions/:id/comments", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    response.json({ comments: sessionStore.listDraftComments(session.id) });
  });

  app.post("/api/sessions/:id/comments", (request, response) => {
    try {
      const session = sessionStore.getSession(request.params.id);
      if (!session) {
        response.status(404).json({ error: "Review session not found." });
        return;
      }
      if (sessionStore.getSubmittedReview(session.id, session.metadata.head.sha)) {
        response.status(409).json({ error: "This review has already been published." });
        return;
      }
      const comment = validateDraftComment(request.body, session.evidence);
      response.status(201).json({ comment: sessionStore.saveDraftComment(session.id, comment) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not stage this comment.";
      response.status(400).json({ error: message });
    }
  });

  app.delete("/api/sessions/:id/comments/:commentId", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    if (sessionStore.getSubmittedReview(session.id, session.metadata.head.sha)) {
      response.status(409).json({ error: "This review has already been published." });
      return;
    }
    if (!sessionStore.deleteDraftComment(session.id, request.params.commentId)) {
      response.status(404).json({ error: "Draft comment not found." });
      return;
    }
    response.status(204).end();
  });

  app.get("/api/sessions/:id/investigations", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    response.json({ entries: sessionStore.listInvestigationEntries(session.id) });
  });

  app.post("/api/sessions/:id/investigations", (request, response) => {
    try {
      const session = sessionStore.getSession(request.params.id);
      if (!session) {
        response.status(404).json({ error: "Review session not found." });
        return;
      }
      const input = investigationEntryInput(request.body);
      response.status(201).json({ entry: sessionStore.createInvestigationEntry(session.id, input) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not start this investigation.";
      response.status(400).json({ error: message });
    }
  });

  app.patch("/api/sessions/:id/investigations/:entryId", (request, response) => {
    try {
      const session = sessionStore.getSession(request.params.id);
      if (!session) {
        response.status(404).json({ error: "Review session not found." });
        return;
      }
      const update = investigationEntryUpdate(request.body);
      const entry = sessionStore.updateInvestigationEntry(session.id, request.params.entryId, update.answer, update.status);
      if (!entry) {
        response.status(404).json({ error: "Investigation entry not found." });
        return;
      }
      response.json({ entry });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not save this investigation.";
      response.status(400).json({ error: message });
    }
  });

  app.get("/api/sessions/:id/review-draft", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    response.json({ draft: sessionStore.getReviewDraft(session.id) ?? null });
  });

  app.put("/api/sessions/:id/review-draft", (request, response) => {
    try {
      const session = sessionStore.getSession(request.params.id);
      if (!session) {
        response.status(404).json({ error: "Review session not found." });
        return;
      }
      if (sessionStore.getSubmittedReview(session.id, session.metadata.head.sha)) {
        throw new Error("A review has already been published for this pinned head.");
      }
      const draft = reviewDraftInput(request.body);
      response.json({ draft: sessionStore.saveReviewDraft(session.id, draft.body, draft.event) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not save this review draft.";
      response.status(400).json({ error: message });
    }
  });

  app.get("/api/sessions/:id/review-submission", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    response.json({ submission: sessionStore.getSubmittedReview(session.id, session.metadata.head.sha) ?? null });
  });

  app.get("/api/sessions/:id/review-publication", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    response.json({ publication: sessionStore.getReviewPublication(session.id, session.metadata.head.sha) ?? null });
  });

  app.delete("/api/sessions/:id/review-publication", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    if (request.body?.verifiedCodeHost !== true && request.body?.verifiedGitHub !== true) {
      response.status(400).json({ error: `Confirm that ${codeHostName(session.target)} does not contain the review before allowing a retry.` });
      return;
    }
    if (!sessionStore.clearUncertainReviewPublication(session.id, session.metadata.head.sha)) {
      response.status(409).json({ error: "Only an uncertain publication can be cleared." });
      return;
    }
    response.status(204).end();
  });

  app.post("/api/sessions/:id/review-submission", async (request, response) => {
    try {
      const session = sessionStore.getSession(request.params.id);
      if (!session) {
        response.status(404).json({ error: "Review session not found." });
        return;
      }
      if (sessionStore.getSubmittedReview(session.id, session.metadata.head.sha)) {
        throw new Error("A review has already been published for this pinned head.");
      }
      const submissionInput = reviewSubmissionInput(request.body);
      const draft = submissionInput.draft;
      sessionStore.saveReviewDraft(session.id, draft.body, draft.event);
      const submission = await submitSessionReview(
        session,
        sessionStore,
        await repositoryPathFor(session),
        draft,
        options.reviewSubmissionDependencies,
        { scope: submissionInput.scope, acknowledgeApprovalRisks: submissionInput.acknowledgeApprovalRisks },
      );
      response.status(201).json({ submission });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not publish this review.";
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
        await repositoryPathFor(session),
        sessionStore,
        undefined,
        options.acquisitionDependencies,
      );
      response.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not check for author updates.";
      response.status(400).json({ error: message });
    }
  });

  app.get("/api/sessions/:id/update", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    const update = sessionStore.getReviewUpdate(session.id);
    response.json({
      update: update ?? null,
      baselineCheckpoint: update ? sessionStore.latestCheckpoint(update.baselineSessionId) ?? null : null,
    });
  });

  app.get("/api/sessions/:id/tour", async (request, response) => {
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
    if (generated.contextFingerprint) {
      try {
        const currentContext = await buildSessionGenerationContext(session, sessionStore, scope, await repositoryPathFor(session));
        if (currentContext.manifest.fingerprint !== generated.contextFingerprint) {
          response.status(409).json({ error: "The model context changed after this tour was generated. Generate it again." });
          return;
        }
      } catch (error) {
        response.status(400).json({ error: error instanceof Error ? error.message : "Tour context could not be verified." });
        return;
      }
    }
    response.json({ generated });
  });

  app.get("/api/sessions/:id/context", async (request, response) => {
    try {
      const session = sessionStore.getSession(request.params.id);
      if (!session) {
        response.status(404).json({ error: "Review session not found." });
        return;
      }
      const scope = tourScope(request.query.scope);
      const context = await buildSessionGenerationContext(session, sessionStore, scope, await repositoryPathFor(session));
      response.json({ manifest: context.manifest });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not prepare the model context.";
      response.status(400).json({ error: message });
    }
  });

  app.put("/api/sessions/:id/context", async (request, response) => {
    try {
      const session = sessionStore.getSession(request.params.id);
      if (!session) {
        response.status(404).json({ error: "Review session not found." });
        return;
      }
      const scope = tourScope(request.body?.scope);
      const patterns = contextExclusions(request.body?.excludedPatterns);
      sessionStore.saveContextExclusions(session.id, patterns);
      const context = await buildSessionGenerationContext(session, sessionStore, scope, await repositoryPathFor(session));
      response.json({ manifest: context.manifest });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not save model-context settings.";
      response.status(400).json({ error: message });
    }
  });

  app.get("/api/sessions/:id/tour-status", (request, response) => {
    const session = sessionStore.getSession(request.params.id);
    if (!session) {
      response.status(404).json({ error: "Review session not found." });
      return;
    }
    response.json({ generation: publicTourGenerationStatus(tourGenerations.get(session.id)) });
  });

  app.post("/api/sessions/:id/tour", (request, response) => {
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

      const active = tourGenerations.get(session.id);
      if (active?.state === "running") {
        if (active.scope !== scope || !sameSelection(active.selection, selection)) {
          response.status(409).json({
            error: `A ${active.scope} guided tour is already being generated for this review.`,
            generation: publicTourGenerationStatus(active),
          });
          return;
        }
        response.status(202).json({ generation: publicTourGenerationStatus(active) });
        return;
      }

      const job: TourGenerationJob = {
        state: "running",
        scope,
        selection,
        startedAt: Date.now(),
        abortController: new AbortController(),
        ...(provider.generationTimeoutMs ? { timeoutMs: provider.generationTimeoutMs } : {}),
      };
      tourGenerations.set(session.id, job);
      void (async () => {
        try {
          await generateSessionTour(
            session,
            selection,
            provider,
            sessionStore,
            scope,
            job.abortController.signal,
            await repositoryPathFor(session),
          );
          job.state = "succeeded";
        } catch (error) {
          job.state = "failed";
          job.error = error instanceof Error ? error.message : "Wingdiff could not generate this tour.";
        } finally {
          job.finishedAt = Date.now();
        }
      })();
      response.status(202).json({ generation: publicTourGenerationStatus(job) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wingdiff could not generate this tour.";
      response.status(400).json({ error: message });
    }
  });

  app.get("/api/providers", (_request, response) => {
    response.json({ providers: publicProviders(environment, new Set(providers.keys())) });
  });

  app.post("/api/sessions/:id/investigate", async (request, response) => {
    try {
      const session = sessionStore.getSession(request.params.id);
      if (!session) {
        response.status(404).json({ error: "Review session not found." });
        return;
      }
      const selection = validateSelection(request.body?.selection);
      const input = sessionInvestigationInput(request.body);
      const provider = providers.get(selection.provider);
      if (!provider) {
        unavailableProvider(response, selection.provider);
        return;
      }
      const context = await buildSessionInvestigationContext(
        session,
        sessionStore,
        input.scope,
        input.stopId,
        input.question,
        await repositoryPathFor(session),
      );
      await streamInvestigationResponse(response, provider, selection, context);
    } catch (error) {
      investigationError(response, error);
    }
  });

  app.post("/api/investigate", async (request, response) => {
    try {
      const selection = validateSelection(request.body?.selection);
      const context = validateInvestigationContext(request.body?.context);
      const provider = providers.get(selection.provider);
      if (!provider) {
        unavailableProvider(response, selection.provider);
        return;
      }
      await streamInvestigationResponse(response, provider, selection, context);
    } catch (error) {
      investigationError(response, error);
    }
  });

  // Routes that throw outside a try block (e.g. a saved review whose host is no longer trusted) still answer in JSON.
  const apiErrorHandler: ErrorRequestHandler = (error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const message = error instanceof Error ? error.message : "Wingdiff could not complete this request.";
    response.status(500).json({ error: message });
  };
  app.use("/api", apiErrorHandler);

  return app;
}

function publicTourGenerationStatus(job: TourGenerationJob | undefined) {
  if (!job) return { state: "idle", elapsedMs: 0 } as const;
  const endedAt = job.finishedAt ?? Date.now();
  return {
    state: job.state,
    scope: job.scope,
    startedAt: new Date(job.startedAt).toISOString(),
    ...(job.finishedAt ? { finishedAt: new Date(job.finishedAt).toISOString() } : {}),
    elapsedMs: Math.max(0, endedAt - job.startedAt),
    ...(job.timeoutMs ? { timeoutMs: job.timeoutMs } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function sameSelection(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort;
}

async function streamInvestigationResponse(
  response: express.Response,
  provider: TextProvider,
  selection: ReturnType<typeof validateSelection>,
  context: ReturnType<typeof validateInvestigationContext>,
) {
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
}

function unavailableProvider(response: express.Response, provider: ProviderId) {
  const setup = provider === "codex"
    ? "Install Codex CLI and run codex login"
    : `set ${provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}`;
  response.status(503).json({ error: `${provider} is not configured. ${setup} before starting Wingdiff.` });
}

function investigationError(response: express.Response, error: unknown) {
  const message = error instanceof Error ? error.message : "Investigation failed.";
  if (!response.headersSent) response.status(400).json({ error: message });
  else {
    response.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
    response.end();
  }
}

function localAuthentication(authToken: string): express.RequestHandler {
  return (request, response, next) => {
    const queryToken = typeof request.query.wingdiff_token === "string" ? request.query.wingdiff_token : undefined;
    if (request.method === "GET" && queryToken && tokenMatches(queryToken, authToken)) {
      const destination = new URL(request.originalUrl, "http://wingdiff.local");
      destination.searchParams.delete("wingdiff_token");
      response.setHeader("Set-Cookie", `wingdiff_auth=${encodeURIComponent(authToken)}; HttpOnly; SameSite=Strict; Path=/`);
      response.setHeader("Cache-Control", "no-store");
      response.redirect(302, `${destination.pathname}${destination.search}${destination.hash}`);
      return;
    }

    if (!request.path.startsWith("/api/")) {
      next();
      return;
    }

    const bearer = request.get("authorization")?.replace(/^Bearer\s+/i, "");
    const cookie = parseCookies(request.get("cookie") ?? "").wingdiff_auth;
    const bearerAuthorized = Boolean(bearer && tokenMatches(bearer, authToken));
    if (!bearerAuthorized && !(cookie && tokenMatches(cookie, authToken))) {
      response.status(401).json({ error: "This Wingdiff session is not authorized." });
      return;
    }

    if (!bearerAuthorized && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.get("origin");
      const expectedOrigin = `${request.protocol}://${request.get("host")}`;
      if (origin !== expectedOrigin) {
        response.status(403).json({ error: "Cross-origin Wingdiff requests are not allowed." });
        return;
      }
    }
    next();
  };
}

function securityHeaders(development: boolean): express.RequestHandler {
  const scriptSources = development ? "'self' 'unsafe-inline'" : "'self'";
  const connectSources = development ? "'self' ws: wss:" : "'self'";
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'none'",
    `connect-src ${connectSources}`,
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    `script-src ${scriptSources}`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
  ].join("; ");

  return (request, response, next) => {
    response.setHeader("Content-Security-Policy", contentSecurityPolicy);
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
    next();
  };
}

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return [];
    try {
      return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
    } catch {
      return [];
    }
  }));
}

function tokenMatches(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
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

function reviewProgressInput(input: unknown): {
  scope: TourScope;
  activeStopId: string;
  change?: { stopId: string; status: ReviewProgressStatus };
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Review progress is required.");
  const value = input as Record<string, unknown>;
  const scope = tourScope(value.scope);
  const activeStopId = requiredText(value.activeStopId, "Active review stop", 128);
  if (value.change === undefined) return { scope, activeStopId };
  if (!value.change || typeof value.change !== "object" || Array.isArray(value.change)) {
    throw new Error("Review progress change is invalid.");
  }
  const change = value.change as Record<string, unknown>;
  const stopId = requiredText(change.stopId, "Review stop", 128);
  const status = change.status;
  if (status !== "unseen" && status !== "understood" && status !== "flagged" && status !== "skipped") {
    throw new Error("Review progress status is invalid.");
  }
  return { scope, activeStopId, change: { stopId, status } };
}

function tourScope(input: unknown): TourScope {
  if (input === undefined || input === null || input === "" || input === "full") return "full";
  if (input === "update") return "update";
  throw new Error(`Invalid tour scope: ${String(input)}`);
}

function reviewDraftInput(input: unknown): Pick<ReviewDraft, "body" | "event"> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Review draft is required.");
  const value = input as Record<string, unknown>;
  const body = typeof value.body === "string" ? value.body : "";
  if (body.length > 65_536) throw new Error("Review summary exceeds 65536 characters.");
  const event = value.event;
  if (event !== "COMMENT" && event !== "APPROVE" && event !== "REQUEST_CHANGES") throw new Error("Review disposition is invalid.");
  return { body, event };
}

function reviewSubmissionInput(input: unknown): {
  draft: Pick<ReviewDraft, "body" | "event">;
  scope: TourScope;
  acknowledgeApprovalRisks: boolean;
} {
  const draft = reviewDraftInput(input);
  const value = input as Record<string, unknown>;
  return {
    draft,
    scope: tourScope(value.scope),
    acknowledgeApprovalRisks: value.acknowledgeApprovalRisks === true,
  };
}

function investigationEntryInput(input: unknown): Pick<InvestigationEntry, "stopId" | "evidenceId" | "question" | "provider" | "model"> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Investigation context is required.");
  const value = input as Record<string, unknown>;
  const provider = value.provider;
  if (provider !== "codex" && provider !== "openai" && provider !== "anthropic") {
    throw new Error("Investigation provider is invalid.");
  }
  return {
    stopId: requiredText(value.stopId, "Investigation stop", 128),
    evidenceId: requiredText(value.evidenceId, "Investigation evidence", 1024),
    question: requiredText(value.question, "Investigation question", 4_000),
    provider,
    model: requiredText(value.model, "Investigation model", 128),
  };
}

function sessionInvestigationInput(input: unknown): { scope: TourScope; stopId: string; question: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Investigation context is required.");
  const value = input as Record<string, unknown>;
  return {
    scope: tourScope(value.scope),
    stopId: requiredText(value.stopId, "Investigation stop", 128),
    question: requiredText(value.question, "Investigation question", 4_000),
  };
}

function investigationEntryUpdate(input: unknown): Pick<InvestigationEntry, "answer" | "status"> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Investigation result is required.");
  const value = input as Record<string, unknown>;
  if (typeof value.answer !== "string" || value.answer.length > 65_536) {
    throw new Error("Investigation answer must be at most 65536 characters.");
  }
  if (value.status !== "complete" && value.status !== "error") throw new Error("Investigation status is invalid.");
  return { answer: value.answer, status: value.status };
}

function contextExclusions(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 50) throw new Error("Context exclusions must contain at most 50 patterns.");
  const patterns = input.map((pattern, index) => requiredText(pattern, `Context exclusion ${index + 1}`, 200));
  if (patterns.some((pattern) => pattern.includes("\0"))) throw new Error("Context exclusions cannot contain null bytes.");
  return [...new Set(patterns)];
}

function requiredText(input: unknown, label: string, maximum: number): string {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${label} is required.`);
  const value = input.trim();
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters.`);
  return value;
}
