import { timingSafeEqual } from "node:crypto";
import express from "express";
import { acquireReviewSession, refreshReviewSession, type AcquisitionDependencies } from "./acquisition.js";
import { validateDraftComment } from "./comments.js";
import { inspectLocalTarget } from "./preflight.js";
import { createProviders, publicProviders, validateSelection } from "./providers/index.js";
import type { ProviderId, TextProvider } from "./providers/types.js";
import { SessionStore } from "./sessions.js";
import type { FindingCheckpoint, InvestigationEntry, ReviewDraft, TourScope } from "./sessions.js";
import { parsePullRequestTarget } from "./targets.js";
import { generateSessionTour, getSessionTour } from "./tourService.js";
import { validateInvestigationContext } from "./validation.js";
import { submitSessionReview, type ReviewSubmissionDependencies } from "./reviews.js";

export interface AppOptions {
  cwd?: string;
  sessionStore?: SessionStore;
  providers?: Map<ProviderId, TextProvider>;
  acquisitionDependencies?: AcquisitionDependencies;
  reviewSubmissionDependencies?: ReviewSubmissionDependencies;
  authToken?: string;
}

export function createApp(environment: NodeJS.ProcessEnv = process.env, options: AppOptions = {}) {
  const app = express();
  const providers = options.providers ?? createProviders(environment);
  const cwd = options.cwd ?? process.cwd();
  const sessionStore = options.sessionStore ?? new SessionStore();

  app.disable("x-powered-by");
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
      const scope = tourScope(request.body?.scope);
      const findingRevisions = findingCheckpoints(request.body?.findingRevisions);
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
      const draft = reviewDraftInput(request.body);
      sessionStore.saveReviewDraft(session.id, draft.body, draft.event);
      const submission = await submitSessionReview(
        session,
        sessionStore,
        cwd,
        draft,
        options.reviewSubmissionDependencies,
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
    const update = sessionStore.getReviewUpdate(session.id);
    response.json({
      update: update ?? null,
      baselineCheckpoint: update ? sessionStore.latestCheckpoint(update.baselineSessionId) ?? null : null,
    });
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
      if (origin && origin !== expectedOrigin) {
        response.status(403).json({ error: "Cross-origin Wingdiff requests are not allowed." });
        return;
      }
    }
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

function tourScope(input: unknown): TourScope {
  if (input === undefined || input === null || input === "" || input === "full") return "full";
  if (input === "update") return "update";
  throw new Error(`Invalid tour scope: ${String(input)}`);
}

function findingCheckpoints(input: unknown) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 100) throw new Error("Finding revisions must be a bounded list.");
  return input.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Finding revision ${index + 1} is invalid.`);
    }
    const value = candidate as Record<string, unknown>;
    const findingId = requiredText(value.findingId, `finding revision ${index + 1} id`, 128);
    const title = requiredText(value.title, `${findingId} title`, 160);
    const summary = requiredText(value.summary, `${findingId} summary`, 420);
    const severity = String(value.severity);
    const state = String(value.state);
    if (!["high", "medium", "low"].includes(severity)) throw new Error(`Invalid severity for ${findingId}.`);
    if (!["new", "still-applies", "appears-addressed", "recheck", "superseded", "resolved"].includes(state)) {
      throw new Error(`Invalid state for ${findingId}.`);
    }
    const pathHints = Array.isArray(value.pathHints)
      ? value.pathHints.map((path, pathIndex) => requiredText(path, `${findingId} path ${pathIndex + 1}`, 500))
      : [];
    return { findingId, title, summary, severity, state, pathHints } as FindingCheckpoint;
  });
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

function investigationEntryUpdate(input: unknown): Pick<InvestigationEntry, "answer" | "status"> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Investigation result is required.");
  const value = input as Record<string, unknown>;
  if (typeof value.answer !== "string" || value.answer.length > 65_536) {
    throw new Error("Investigation answer must be at most 65536 characters.");
  }
  if (value.status !== "complete" && value.status !== "error") throw new Error("Investigation status is invalid.");
  return { answer: value.answer, status: value.status };
}

function requiredText(input: unknown, label: string, maximum: number): string {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${label} is required.`);
  const value = input.trim();
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters.`);
  return value;
}
