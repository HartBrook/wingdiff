import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { mockAnswers, pullRequest, reviewUpdate, tourStops, updateStops } from "./fixture";
import {
  DEFAULT_SELECTION,
  FALLBACK_PROVIDERS,
  fetchProviders,
  selectedModel,
  streamInvestigation,
  streamSessionInvestigation,
} from "./ai";
import type {
  DraftComment,
  EvidenceBlock,
  FindingRevision,
  NotebookEntry,
  ModelSelection,
  ProviderDefinition,
  ReviewDisposition,
  ReviewMode,
  RiskLevel,
  StopStatus,
  TourStop,
  View,
} from "./types";
import { CodeDiff } from "./components/CodeDiff";
import { Icon } from "./components/Icon";
import { acquisitionBlocker, addRecentTarget, parseLaunchRoute, preparePullRequestTarget, type LaunchRoute, type PullRequestTarget, type TargetPreparation } from "./launcher";
import { claimKindLabel, compareSeverity } from "./reviewPresentation";
import {
  createReviewSession,
  clearUncertainReviewPublication,
  createDraftComment,
  createInvestigationEntry,
  completeReviewCheckpoint,
  deleteDraftComment,
  evidenceBlocksFor,
  fetchReviewCheckpoint,
  fetchReviewProgress,
  fetchReviewSession,
  fetchDraftComments,
  fetchInvestigationEntries,
  fetchReviewDraft,
  fetchReviewSubmission,
  fetchReviewPublication,
  fetchSessionTour,
  fetchSessionContext,
  fetchSessionUpdate,
  generatedTourStops,
  generateSessionTour,
  refreshReviewSession,
  publishReview,
  revisionStopIndex,
  saveReviewDraft,
  saveReviewProgress,
  saveSessionContext,
  updateInvestigationEntry,
  type AcquiredReviewSession,
  type FindingCheckpoint,
  type GeneratedSessionTour,
  type ReviewCheckpoint,
  type ReviewProgressSnapshot,
  type SessionContextManifest,
  type StoredReviewSubmission,
  type StoredReviewPublication,
  type StoredReviewUpdate,
} from "./session";

interface Selection {
  evidenceId: string;
  side?: "LEFT" | "RIGHT";
  start: number;
  end: number;
}

interface ComposerState {
  stop: TourStop;
  evidence: EvidenceBlock;
  side?: "LEFT" | "RIGHT";
  startLine: number;
  endLine: number;
  fingerprint?: string;
  body: string;
  severity: RiskLevel;
}

type AcquiredScope = "full" | "update";

const MarkdownContent = lazy(() => import("./components/MarkdownContent"));

const initialStatuses = Object.fromEntries(
  tourStops.map((stop) => [stop.id, "unseen"]),
) as Record<string, StopStatus>;

const rankedFindings = tourStops
  .flatMap((stop, stopIndex) => stop.finding ? [{ finding: stop.finding, stop, stopIndex }] : [])
  .sort((left, right) => compareSeverity(left.finding.severity, right.finding.severity));

export default function App() {
  const [route, setRoute] = useState<LaunchRoute>(() => parseLaunchRoute(window.location.search));

  useEffect(() => {
    const syncRoute = () => setRoute(parseLaunchRoute(window.location.search));
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  function navigate(search: string) {
    window.history.pushState({}, "", `${window.location.pathname}${search}`);
    setRoute(parseLaunchRoute(search));
  }

  if (route.session) return <SessionLoader id={route.session} onHome={() => navigate("")} onSession={(id) => navigate(`?session=${encodeURIComponent(id)}`)} />;
  if (route.demo) return <ReviewApp onHome={() => navigate("")} />;
  return <Launcher
    initialTarget={route.target}
    onDemo={() => navigate("?demo=1")}
    onSession={(id) => navigate(`?session=${encodeURIComponent(id)}`)}
  />;
}

function Launcher({ initialTarget, onDemo, onSession }: { initialTarget?: string; onDemo: () => void; onSession: (id: string) => void }) {
  const [input, setInput] = useState(initialTarget ?? "");
  const [preparation, setPreparation] = useState<TargetPreparation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [acquiring, setAcquiring] = useState(false);
  const [recent, setRecent] = usePersistentState<PullRequestTarget[]>("wingdiff:recent-targets", []);
  const [theme, setTheme] = usePersistentState<"dark" | "light">("wingdiff:theme", "dark");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!initialTarget) return;
    const controller = new AbortController();
    void submitTarget(initialTarget, controller.signal);
    return () => controller.abort();
  }, []);

  async function submitTarget(value = input, signal?: AbortSignal) {
    const candidate = value.trim();
    if (!candidate || submitting) return;
    setInput(candidate);
    setSubmitting(true);
    setError(null);
    setPreparation(null);
    try {
      const prepared = await preparePullRequestTarget(candidate, signal);
      setPreparation(prepared);
      setRecent((current) => addRecentTarget(current, prepared.target));
      window.history.replaceState({}, "", `?target=${encodeURIComponent(prepared.target.canonicalUrl)}`);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Wingdiff could not read that pull request target.");
    } finally {
      setSubmitting(false);
    }
  }

  async function openPullRequest() {
    if (!preparation || acquiring) return;
    setAcquiring(true);
    setError(null);
    try {
      const session = await createReviewSession(preparation.target.canonicalUrl);
      onSession(session.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wingdiff could not open this pull request.");
    } finally {
      setAcquiring(false);
    }
  }

  const blocker = preparation ? acquisitionBlocker(preparation) : undefined;
  const canAcquire = Boolean(preparation && !blocker);

  return <div className="launcher-shell">
    <header className="launcher-topbar">
      <div className="brand"><span className="brand__mark"><Icon name="route" size={19} /></span><span>wingdiff</span></div>
      <span className="launcher-local"><i /> Running locally</span>
      <button aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`} className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} type="button"><Icon name={theme === "dark" ? "sun" : "moon"} size={17} /></button>
    </header>
    <main className="launcher-main">
      <section className="launcher-intro">
        <div className="eyebrow">Start a review</div>
        <h1>Choose a pull request.</h1>
        <p>Wingdiff checks your local setup, then builds a guided review.</p>
        <form className={`target-form ${error ? "is-error" : ""}`} onSubmit={(event) => { event.preventDefault(); void submitTarget(); }}>
          <Icon name="git-pull" size={19} />
          <input autoFocus aria-label="GitHub pull request" onChange={(event) => { setInput(event.target.value); setPreparation(null); setError(null); }} placeholder="https://github.com/owner/repo/pull/123" spellCheck={false} value={input} />
          <button disabled={!input.trim() || submitting} type="submit">{submitting ? "Checking setup…" : preparation ? "Recheck setup" : "Check setup"}<Icon name="arrow-right" size={16} /></button>
        </form>
        {error && <div className="target-error" role="alert"><Icon name="flag" size={14} />{error}</div>}
        <div className="target-help"><span>Also accepts</span><code>owner/repo#123</code><span>or run</span><code>wingdiff 123</code><span>inside a checkout</span></div>
      </section>

      {preparation ? <section className="target-ready">
        <span className="target-ready__icon"><Icon name="check" size={19} /></span>
        <div><div className="eyebrow">{blocker ? "Setup needed" : "Ready to review"}</div><h2>{preparation.target.label}</h2><p>{checkoutMessage(preparation)} · {preparation.environment.githubCli.installed ? "GitHub CLI installed" : "GitHub CLI not found"}. No GitHub request was made.</p>{blocker && <p className="target-ready__blocker" role="alert"><Icon name="flag" size={13} />{blocker}</p>}</div>
        <div className="target-ready__actions"><button className="button button--primary" disabled={!canAcquire || acquiring} onClick={() => void openPullRequest()} title={blocker} type="button">{acquiring ? "Preparing review…" : "Start review"}<Icon name="arrow-right" size={15} /></button><button className="button button--quiet" onClick={onDemo} type="button">Try demo</button></div>
      </section> : recent.length > 0 ? <section className="recent-targets">
        <header><span>Recent pull requests</span><small>Stored on this device</small></header>
        {recent.map((item) => <button key={item.canonicalUrl} onClick={() => void submitTarget(item.canonicalUrl)} type="button"><span><strong>{item.label}</strong><small>{item.canonicalUrl}</small></span><Icon name="chevron-right" size={15} /></button>)}
      </section> : <button className="demo-link" onClick={onDemo} type="button"><span><Icon name="spark" size={15} /> Try the demo review</span><Icon name="arrow-right" size={14} /></button>}
    </main>
    <footer className="launcher-footer"><span><Icon name="shield" size={13} /> Local server · no Wingdiff account</span><code>127.0.0.1</code></footer>
  </div>;
}

function SessionLoader({ id, onHome, onSession }: { id: string; onHome: () => void; onSession: (id: string) => void }) {
  const [session, setSession] = useState<AcquiredReviewSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchReviewSession(id, controller.signal).then(setSession).catch((caught) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Wingdiff could not resume this review session.");
    });
    return () => controller.abort();
  }, [id]);

  if (error) return <div className="session-state"><span className="card-icon"><Icon name="flag" /></span><h1>Couldn’t open this review.</h1><p>{error}</p><button className="button button--primary" onClick={onHome} type="button">New review</button></div>;
  if (!session) return <div className="session-state"><span className="card-icon card-icon--spark"><Icon name="spark" /></span><h1>Opening local evidence…</h1><p>Reading the pinned review session from this device.</p></div>;
  return <AcquiredReviewApp onHome={onHome} onSession={onSession} session={session} />;
}

function AcquiredReviewApp({ onHome, onSession, session }: { onHome: () => void; onSession: (id: string) => void; session: AcquiredReviewSession }) {
  const [view, setView] = useState<"summary" | "tour" | "browse" | "review">("summary");
  const [theme, setTheme] = usePersistentState<"dark" | "light">("wingdiff:theme", "dark");
  const [tours, setTours] = useState<Record<AcquiredScope, GeneratedSessionTour | null>>({ full: null, update: null });
  const [reviewScope, setReviewScope] = useState<AcquiredScope>("full");
  const [update, setUpdate] = useState<StoredReviewUpdate | null>(null);
  const [baselineCheckpoint, setBaselineCheckpoint] = useState<ReviewCheckpoint | null>(null);
  const [checkpoints, setCheckpoints] = useState<Record<AcquiredScope, ReviewCheckpoint | null>>({ full: null, update: null });
  const [tourLoading, setTourLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderDefinition[]>(FALLBACK_PROVIDERS);
  const [modelSelection, setModelSelection] = usePersistentState<ModelSelection>("wingdiff:model", DEFAULT_SELECTION);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [contextManifest, setContextManifest] = useState<SessionContextManifest | null>(null);
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextSaving, setContextSaving] = useState(false);
  const [exclusionText, setExclusionText] = useState("");
  const [mobileRouteOpen, setMobileRouteOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null);
  const tourCanvasRef = useRef<HTMLElement>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [progress, setProgress] = useState<ReviewProgressSnapshot>({
    activeScope: null,
    activeStopIds: { full: null, update: null },
    scopes: { full: {}, update: {} },
  });
  const [comments, setComments] = useState<DraftComment[]>([]);
  const [notebook, setNotebook] = useState<NotebookEntry[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answering, setAnswering] = useState(false);
  const investigationAbort = useRef<AbortController | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [reviewSummary, setReviewSummary] = useState("");
  const [disposition, setDisposition] = useState<ReviewDisposition>("COMMENT");
  const [savingReview, setSavingReview] = useState(false);
  const [publishingReview, setPublishingReview] = useState(false);
  const [submission, setSubmission] = useState<StoredReviewSubmission | null>(null);
  const [publication, setPublication] = useState<StoredReviewPublication | null>(null);
  const generated = tours[reviewScope];
  const checkpoint = checkpoints[reviewScope];
  const statuses = progress.scopes[reviewScope];
  const scopedEvidence = reviewScope === "update" && update ? update.evidence : session.evidence;
  const blocks = useMemo(() => evidenceBlocksFor(scopedEvidence), [scopedEvidence]);
  const stops = useMemo(() => generated ? generatedTourStops(session, generated, scopedEvidence) : [], [generated, scopedEvidence, session]);
  const metadata = session.metadata;
  const activeStop = stops[activeIndex];
  const activeEvidence = activeStop?.evidence.find((item) => item.id === activeEvidenceId) ?? activeStop?.evidence[0];
  const stopNotebook = activeStop ? notebook.filter((entry) => entry.stopId === activeStop.id) : [];
  const activeProvider = providers.find((provider) => provider.id === modelSelection.provider);
  const activeModel = selectedModel(providers, modelSelection);
  const activeModelLabel = activeProvider ? `${activeProvider.name} · ${activeModel.name}` : activeModel.name;
  const activeFindingRevisions = generated?.tour.findingRevisions.flatMap((revision) => {
    const prior = baselineCheckpoint?.findingRevisions.find((finding) => finding.findingId === revision.findingId);
    return prior && revisionStopIndex(generated, revision.anchorIds) === activeIndex ? [{ prior, revision }] : [];
  }) ?? [];
  const unresolvedHighFindingCount = stops.filter((stop) => stop.finding?.severity === "high").length
    + (generated?.tour.findingRevisions.filter((revision) => {
      const prior = baselineCheckpoint?.findingRevisions.find((finding) => finding.findingId === revision.findingId);
      return prior?.severity === "high" && (revision.state === "still-applies" || revision.state === "recheck");
    }).length ?? 0);
  const inheritedStopIds = useMemo(() => {
    if (reviewScope !== "full" || !update || !baselineCheckpoint) return new Set<string>();
    const changedPaths = new Set(update.evidence.files.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]));
    return new Set(stops.filter((stop) => {
      const prior = baselineCheckpoint.coverage[`full-${stop.id}`] ?? baselineCheckpoint.coverage[stop.id];
      return prior === "understood" && stop.evidence.every((evidence) => !changedPaths.has(evidence.path));
    }).map((stop) => stop.id));
  }, [baselineCheckpoint, reviewScope, stops, update]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetchSessionTour(session.id, "full", controller.signal),
      fetchSessionTour(session.id, "update", controller.signal),
      fetchSessionUpdate(session.id, controller.signal),
      fetchReviewCheckpoint(session.id, "full", controller.signal),
      fetchReviewCheckpoint(session.id, "update", controller.signal),
      fetchReviewProgress(session.id, controller.signal),
      fetchDraftComments(session.id, controller.signal),
      fetchInvestigationEntries(session.id, controller.signal),
      fetchReviewDraft(session.id, controller.signal),
      fetchReviewSubmission(session.id, controller.signal),
      fetchReviewPublication(session.id, controller.signal),
      fetchProviders(controller.signal).then((availableProviders) => {
        setProviders(availableProviders);
        setModelSelection((current) => preferredAvailableSelection(availableProviders, current));
      }),
    ]).then(([fullTour, updateTour, updateContext, fullCheckpoint, updateCheckpoint, storedProgress, storedComments, storedNotebook, storedReviewDraft, storedSubmission, storedPublication]) => {
      setTours({ full: fullTour, update: updateTour });
      setUpdate(updateContext?.update ?? null);
      setBaselineCheckpoint(updateContext?.baselineCheckpoint ?? null);
      setCheckpoints({ full: fullCheckpoint, update: updateCheckpoint });
      setProgress(storedProgress);
      setComments(storedComments);
      setNotebook(storedNotebook);
      setReviewSummary(storedReviewDraft?.body ?? "");
      setDisposition(storedReviewDraft?.event ?? "COMMENT");
      setSubmission(storedSubmission);
      setPublication(storedPublication);
      const restoredScope = storedProgress.activeScope === "update" && !updateContext
        ? "full"
        : storedProgress.activeScope ?? (updateContext ? "update" : "full");
      setReviewScope(restoredScope);
      const restoredTour = restoredScope === "update" ? updateTour : fullTour;
      const restoredStopId = storedProgress.activeStopIds[restoredScope];
      const restoredIndex = restoredTour?.tour.stops.findIndex((stop) => stop.id === restoredStopId) ?? -1;
      setActiveIndex(restoredIndex >= 0 ? restoredIndex : 0);
    }).catch((caught) => {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Wingdiff could not prepare this review.");
    }).finally(() => setTourLoading(false));
    return () => controller.abort();
  }, [session.id]);

  useEffect(() => {
    setActiveEvidenceId(activeStop?.evidence[0]?.id ?? null);
    setSelection(null);
  }, [activeStop]);

  useEffect(() => {
    if (view === "tour") tourCanvasRef.current?.scrollTo({ top: 0 });
  }, [activeIndex, reviewScope, view]);

  async function generateTour() {
    if (!activeProvider?.configured) {
      setModelPickerOpen(true);
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const result = await generateSessionTour(session.id, modelSelection, reviewScope);
      setTours((current) => ({ ...current, [reviewScope]: result }));
      setActiveIndex(0);
      if (result.tour.stops[0]) void persistProgress(reviewScope, result.tour.stops[0].id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wingdiff could not generate this guided tour.");
    } finally {
      setGenerating(false);
    }
  }

  async function previewGenerationContext() {
    if (!activeProvider?.configured) {
      setModelPickerOpen(true);
      return;
    }
    setContextLoading(true);
    setError(null);
    try {
      const manifest = await fetchSessionContext(session.id, reviewScope);
      setContextManifest(manifest);
      setExclusionText(manifest.excludedPatterns.join("\n"));
      setContextPreviewOpen(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wingdiff could not prepare the model context.");
    } finally {
      setContextLoading(false);
    }
  }

  async function confirmGenerationContext() {
    if (!contextManifest || contextSaving) return;
    setContextSaving(true);
    setError(null);
    try {
      const excludedPatterns = [...new Set(exclusionText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
      const changed = JSON.stringify(excludedPatterns) !== JSON.stringify(contextManifest.excludedPatterns);
      let effectiveManifest = contextManifest;
      if (changed) {
        const manifest = await saveSessionContext(session.id, reviewScope, excludedPatterns);
        setContextManifest(manifest);
        effectiveManifest = manifest;
        setTours({ full: null, update: null });
      }
      if (!effectiveManifest.includedFiles) throw new Error("Keep at least one changed file in model context.");
      if (!effectiveManifest.ready) throw new Error("Reduce model context before generation.");
      setContextPreviewOpen(false);
      await generateTour();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wingdiff could not save the model context.");
    } finally {
      setContextSaving(false);
    }
  }

  async function completeReview() {
    if (!generated || stops.some((stop) => (statuses[stop.id] ?? "unseen") === "unseen")) return;
    setCompleting(true);
    setError(null);
    try {
      const coverage = {
        ...Object.fromEntries(stops.map((stop) => [
          stop.id,
          statuses[stop.id] ?? "understood",
        ])),
      };
      const saved = await completeReviewCheckpoint(session.id, reviewScope, coverage);
      setCheckpoints((current) => ({ ...current, [reviewScope]: saved }));
      setNotice(`Review checkpoint saved at ${saved.reviewedHeadSha.slice(0, 7)}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wingdiff could not complete this review.");
    } finally {
      setCompleting(false);
    }
  }

  async function checkForUpdates() {
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await refreshReviewSession(session.id);
      if (result.status === "updated") onSession(result.session.id);
      else setNotice(`No changes after ${result.session.metadata.head.sha.slice(0, 7)}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wingdiff could not check for updates.");
    } finally {
      setRefreshing(false);
    }
  }

  function selectScope(scope: AcquiredScope) {
    setReviewScope(scope);
    const scopeStops = tours[scope]?.tour.stops ?? [];
    const restoredIndex = scopeStops.findIndex((stop) => stop.id === progress.activeStopIds[scope]);
    const nextIndex = restoredIndex >= 0 ? restoredIndex : 0;
    setActiveIndex(nextIndex);
    setView("summary");
    setError(null);
    if (scopeStops[nextIndex]) void persistProgress(scope, scopeStops[nextIndex].id);
  }

  async function persistProgress(
    scope: AcquiredScope,
    activeStopId: string,
    change?: { stopId: string; status: StopStatus },
  ) {
    try {
      await saveReviewProgress(session.id, scope, activeStopId, change);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wingdiff could not save review progress.");
    }
  }

  function selectStop(index: number) {
    const next = stops[index];
    if (!next) return;
    setActiveIndex(index);
    void persistProgress(reviewScope, next.id);
  }

  function navigateStop(delta: number) {
    const nextIndex = Math.max(0, Math.min(stops.length - 1, activeIndex + delta));
    selectStop(nextIndex);
  }

  function setStopStatus(stopId: string, status: StopStatus, activeStopId = stopId) {
    setProgress((current) => ({
      ...current,
      activeScope: reviewScope,
      activeStopIds: { ...current.activeStopIds, [reviewScope]: activeStopId },
      scopes: { ...current.scopes, [reviewScope]: { ...current.scopes[reviewScope], [stopId]: status } },
    }));
    void persistProgress(reviewScope, activeStopId, { stopId, status });
  }

  function selectLine(evidenceId: string, line: number, side: "LEFT" | "RIGHT", extend: boolean) {
    setSelection((current) => !extend || !current || current.evidenceId !== evidenceId || current.side !== side
      ? { evidenceId, side, start: line, end: line }
      : { ...current, end: line });
  }

  function openComment(useFinding = false, initialBody = "", preferredEvidenceId?: string) {
    if (submission) {
      setError("This review has already been published to GitHub.");
      setView("review");
      return;
    }
    if (!activeStop || !activeEvidence) return;
    const preferredEvidence = activeStop.evidence.find((item) => item.id === preferredEvidenceId);
    const selectedEvidence = activeStop.evidence.find((item) => item.id === selection?.evidenceId);
    const findingEvidence = activeStop.evidence.find((item) => item.id === activeStop.finding?.evidenceId);
    const evidence = preferredEvidence ?? selectedEvidence ?? (useFinding ? findingEvidence : activeEvidence) ?? activeEvidence;
    const anchor = commentAnchor(evidence, selection?.evidenceId === evidence.id ? selection : null);
    if (!anchor) {
      setError("This evidence does not contain a line that GitHub can anchor a comment to.");
      return;
    }
    setComposer({
      stop: activeStop,
      evidence,
      side: anchor.side,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      fingerprint: anchor.fingerprint,
      body: initialBody || (useFinding ? activeStop.finding?.suggestedComment ?? "" : ""),
      severity: useFinding ? activeStop.finding?.severity ?? "medium" : "low",
    });
  }

  async function stageComment() {
    if (!composer?.body.trim() || !composer.side || !composer.fingerprint) return;
    setError(null);
    try {
      const saved = await createDraftComment(session.id, {
        stopId: composer.stop.id,
        evidenceId: composer.evidence.id,
        path: composer.evidence.path,
        side: composer.side,
        startLine: composer.startLine,
        endLine: composer.endLine,
        body: composer.body.trim(),
        severity: composer.severity,
        fingerprint: composer.fingerprint,
      });
      setComments((current) => [...current, saved]);
      setComposer(null);
      setNotice("Draft comment saved locally.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wingdiff could not stage this comment.");
    }
  }

  async function persistReviewDraft(body = reviewSummary, event = disposition) {
    setSavingReview(true);
    setError(null);
    try {
      const saved = await saveReviewDraft(session.id, body, event);
      setReviewSummary(saved.body);
      setDisposition(saved.event);
      setNotice("Review draft saved locally.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wingdiff could not save this review draft.");
    } finally {
      setSavingReview(false);
    }
  }

  async function removeComment(commentId: string) {
    setError(null);
    try {
      await deleteDraftComment(session.id, commentId);
      setComments((current) => current.filter((comment) => comment.id !== commentId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wingdiff could not remove this draft comment.");
    }
  }

  async function publishReviewToGitHub(acknowledgeApprovalRisks = false) {
    if (submission || publishingReview) return;
    setPublishingReview(true);
    setError(null);
    setNotice(null);
    try {
      const published = await publishReview(session.id, reviewSummary, disposition, reviewScope, acknowledgeApprovalRisks);
      setSubmission(published);
      setPublication(null);
      setNotice("Review published to GitHub.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wingdiff could not publish this review.");
      try {
        setPublication(await fetchReviewPublication(session.id));
      } catch {
        // Preserve the publication error if status refresh also fails.
      }
    } finally {
      setPublishingReview(false);
    }
  }

  async function allowPublicationRetry() {
    setError(null);
    try {
      await clearUncertainReviewPublication(session.id);
      setPublication(null);
      setNotice("Publication retry enabled after GitHub verification.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Wingdiff could not enable a retry.");
    }
  }

  async function askQuestion(prompt?: string) {
    const value = (prompt ?? question).trim();
    if (!value || answering || !activeStop || !activeEvidence) return;
    if (!activeProvider?.configured) {
      setModelPickerOpen(true);
      return;
    }
    setQuestion("");
    setAnswering(true);
    setError(null);
    const controller = new AbortController();
    investigationAbort.current = controller;
    let entryId: string | undefined;
    let answer = "";
    try {
      const entry = await createInvestigationEntry(session.id, {
        stopId: activeStop.id,
        evidenceId: activeEvidence.id,
        question: value,
        provider: modelSelection.provider,
        model: activeModelLabel,
      });
      entryId = entry.id;
      setNotebook((current) => [...current, entry]);
      await streamSessionInvestigation({
        sessionId: session.id,
        scope: reviewScope,
        selection: modelSelection,
        stopId: activeStop.id,
        question: value,
        signal: controller.signal,
        onDelta: (delta) => {
          answer += delta;
          setNotebook((current) => current.map((item) => item.id === entry.id ? { ...item, answer } : item));
        },
      });
      const saved = await updateInvestigationEntry(session.id, entry.id, answer, "complete");
      setNotebook((current) => current.map((item) => item.id === entry.id ? saved : item));
    } catch (caught) {
      const interrupted = caught instanceof DOMException && caught.name === "AbortError";
      const message = interrupted
        ? "Investigation stopped."
        : caught instanceof Error ? caught.message : "The model request failed.";
      const errorAnswer = answer || message;
      if (entryId) {
        try {
          const saved = await updateInvestigationEntry(session.id, entryId, errorAnswer, "error");
          setNotebook((current) => current.map((item) => item.id === entryId ? saved : item));
        } catch {
          updateNotebookEntry(setNotebook, entryId, { answer: errorAnswer, status: "error" });
        }
      } else if (!interrupted) {
        setError(message);
      }
    } finally {
      if (investigationAbort.current === controller) investigationAbort.current = null;
      setAnswering(false);
    }
  }

  function closeInvestigation() {
    investigationAbort.current?.abort();
    setDrawerOpen(false);
  }

  function useInvestigationAsComment(entry: NotebookEntry) {
    if (!entry.answer.trim() || entry.status !== "complete") return;
    openComment(false, entry.answer.trim(), entry.evidenceId);
    setDrawerOpen(false);
  }

  function markUnderstood() {
    if (!activeStop) return;
    const next = stops[activeIndex + 1];
    setStopStatus(activeStop.id, "understood", next?.id ?? activeStop.id);
    if (next) setActiveIndex(activeIndex + 1);
    else setView("summary");
  }

  function toggleFlag() {
    if (!activeStop) return;
    setStopStatus(activeStop.id, statuses[activeStop.id] === "flagged" ? "unseen" : "flagged");
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea, [contenteditable='true']")) return;
      if (event.key === "j" && view === "tour") navigateStop(1);
      if (event.key === "k" && view === "tour") navigateStop(-1);
      if (event.key === "a" && view === "tour") setDrawerOpen(true);
      if (event.key === "c" && view === "tour") openComment();
      if (event.key === "f" && view === "tour") toggleFlag();
      if (event.key === "d") setView((current) => current === "browse" ? (generated ? "tour" : "summary") : "browse");
      if (event.key === "r") setView("review");
      if (event.key === "Escape") {
        closeInvestigation();
        setComposer(null);
        setMobileRouteOpen(false);
        setModelPickerOpen(false);
        setContextPreviewOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  return <div className="app-shell acquired-shell">
    <header className="topbar">
      <button aria-label="Open review route" className="icon-button mobile-menu" onClick={() => setMobileRouteOpen((open) => !open)} type="button"><Icon name="menu" /></button>
      <div className="brand"><span className="brand__mark"><Icon name="route" size={19} /></span><span>wingdiff</span></div>
      <div className="topbar__divider" />
      <button className="home-button" onClick={onHome} type="button"><Icon name="arrow-left" size={14} /><span>New review</span></button>
      <div className="pr-identity"><span>{metadata.repository}</span><strong>#{metadata.number}</strong><span className="pr-identity__title">{metadata.title}</span></div>
      <div className="topbar__spacer" />
      <button className="model-button" onClick={() => setModelPickerOpen(true)} type="button"><span className="model-button__spark"><Icon name="spark" size={13} /></span><span><small>{activeProvider?.configured ? "Review model" : "Model setup"}</small><strong>{activeModelLabel}</strong></span><Icon name="chevron-right" size={13} /></button>
      <a className="button button--quiet acquired-github-link" href={metadata.url} rel="noreferrer" target="_blank">GitHub <Icon name="external" size={14} /></a>
      <button className="button button--primary topbar__review" onClick={() => setView("review")} type="button">Review {comments.length > 0 && <span>{comments.length}</span>}</button>
      <button aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`} className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} type="button"><Icon name={theme === "dark" ? "sun" : "moon"} size={17} /></button>
    </header>
    {view === "tour" && generated && activeStop && activeEvidence ? <div className={`workspace acquired-workspace ${mobileRouteOpen ? "is-mobile-open" : ""}`}>
      <AcquiredTourRail activeIndex={activeIndex} inheritedStopIds={inheritedStopIds} onBrowse={() => { setView("browse"); setMobileRouteOpen(false); }} onReview={() => { setView("review"); setMobileRouteOpen(false); }} onSelect={(index) => { selectStop(index); setMobileRouteOpen(false); }} onSummary={() => { setView("summary"); setMobileRouteOpen(false); }} statuses={statuses} stops={stops} />
      <main className="main-canvas" ref={tourCanvasRef}><AcquiredTourView activeEvidence={activeEvidence} activeEvidenceId={activeEvidenceId} activeFindingRevisions={activeFindingRevisions} activeIndex={activeIndex} comments={comments.filter((comment) => comment.stopId === activeStop.id).length} headSha={metadata.head.sha} onAsk={(prompt) => { setDrawerOpen(true); if (prompt) void askQuestion(prompt); }} onComment={() => openComment(false)} onEvidence={setActiveEvidenceId} onFindingComment={() => openComment(true)} onFlag={toggleFlag} onNavigate={navigateStop} onSelectLine={selectLine} onUnderstood={markUnderstood} selection={selection} status={statuses[activeStop.id] ?? "unseen"} stop={activeStop} totalStops={stops.length} /></main>
    </div> : <main className="main-canvas acquired-canvas">
      {view === "summary" ? <AcquiredSummary activeModel={activeModelLabel} baselineCheckpoint={baselineCheckpoint} checkpoint={checkpoint} completing={completing} error={error} generated={generated} generating={generating || contextLoading} modelReady={Boolean(activeProvider?.configured)} notice={notice} onBegin={() => { selectStop(activeIndex); setView("tour"); }} onBrowse={() => setView("browse")} onCheckUpdates={() => void checkForUpdates()} onComplete={() => void completeReview()} onGenerate={() => void previewGenerationContext()} onScope={selectScope} onSelectStop={(index) => { selectStop(index); setView("tour"); }} refreshing={refreshing} reviewScope={reviewScope} scopedEvidence={scopedEvidence} session={session} statuses={statuses} stops={stops} tourLoading={tourLoading} update={update} /> : view === "browse" ? <AcquiredBrowse blocks={blocks} onSummary={() => setView("summary")} scope={reviewScope} session={session} /> : <AcquiredReviewDesk comments={comments} disposition={disposition} error={error} failedChecks={metadata.checks.failed} headSha={metadata.head.sha} highFindingCount={unresolvedHighFindingCount} onAllowRetry={() => void allowPublicationRetry()} onBack={() => setView(generated ? "tour" : "summary")} onDisposition={(event) => { setDisposition(event); void persistReviewDraft(reviewSummary, event); }} onPublish={(acknowledged) => void publishReviewToGitHub(acknowledged)} onRemoveComment={(id) => void removeComment(id)} onSave={() => void persistReviewDraft()} onSummary={setReviewSummary} publication={publication} publishing={publishingReview} saving={savingReview} statuses={statuses} stops={stops} submission={submission} summary={reviewSummary} />}
    </main>}
    {modelPickerOpen && <ModelPicker onClose={() => setModelPickerOpen(false)} onSelection={setModelSelection} providers={providers} selection={modelSelection} />}
    {contextPreviewOpen && contextManifest && activeProvider && <ContextPreview error={error} exclusions={exclusionText} manifest={contextManifest} modelName={activeModel.name} onCancel={() => setContextPreviewOpen(false)} onConfirm={() => void confirmGenerationContext()} onExclusions={setExclusionText} provider={activeProvider} saving={contextSaving} />}
    {drawerOpen && activeStop && activeEvidence && <InvestigationDrawer answering={answering} entries={stopNotebook} evidence={activeEvidence} headSha={metadata.head.sha} modelName={activeModelLabel} onAsk={askQuestion} onClose={closeInvestigation} onQuestion={setQuestion} onUseAnswer={useInvestigationAsComment} providerConfigured={Boolean(activeProvider?.configured)} question={question} stop={activeStop} />}
    {composer && <CommentComposer composer={composer} headSha={metadata.head.sha} onCancel={() => setComposer(null)} onChange={(body) => setComposer((current) => current ? { ...current, body } : null)} onSeverity={(severity) => setComposer((current) => current ? { ...current, severity } : null)} onStage={stageComment} />}
  </div>;
}

function AcquiredSummary({ activeModel, baselineCheckpoint, checkpoint, completing, error, generated, generating, modelReady, notice, onBegin, onBrowse, onCheckUpdates, onComplete, onGenerate, onScope, onSelectStop, refreshing, reviewScope, scopedEvidence, session, statuses, stops, tourLoading, update }: {
  activeModel: string;
  baselineCheckpoint: ReviewCheckpoint | null;
  checkpoint: ReviewCheckpoint | null;
  completing: boolean;
  error: string | null;
  generated: GeneratedSessionTour | null;
  generating: boolean;
  modelReady: boolean;
  notice: string | null;
  onBegin: () => void;
  onBrowse: () => void;
  onCheckUpdates: () => void;
  onComplete: () => void;
  onGenerate: () => void;
  onScope: (scope: AcquiredScope) => void;
  onSelectStop: (index: number) => void;
  refreshing: boolean;
  reviewScope: AcquiredScope;
  scopedEvidence: AcquiredReviewSession["evidence"];
  session: AcquiredReviewSession;
  statuses: Record<string, StopStatus>;
  stops: TourStop[];
  tourLoading: boolean;
  update: StoredReviewUpdate | null;
}) {
  const metadata = session.metadata;
  const initials = metadata.author.login.slice(0, 2).toUpperCase();
  const findings = stops.flatMap((stop, stopIndex) => stop.finding ? [{ finding: stop.finding, stop, stopIndex }] : []).sort((left, right) => compareSeverity(left.finding.severity, right.finding.severity));
  const earlierFindings = (generated ? generated.tour.findingRevisions : []).flatMap((revision) => {
    const prior = baselineCheckpoint?.findingRevisions.find((finding) => finding.findingId === revision.findingId);
    return prior ? [{ prior, revision, stopIndex: revisionStopIndex(generated!, revision.anchorIds) }] : [];
  }).sort((left, right) => compareSeverity(left.prior.severity, right.prior.severity));
  const blockingEarlier = earlierFindings.filter(({ revision }) => revision.state === "still-applies" || revision.state === "recheck");
  const blockingCount = findings.length + blockingEarlier.length;
  const hasHighBlocker = findings.some(({ finding }) => finding.severity === "high") || blockingEarlier.some(({ prior }) => prior.severity === "high");
  const reviewedStops = stops.filter((stop) => (statuses[stop.id] ?? "unseen") !== "unseen").length;
  const allReviewed = stops.length > 0 && reviewedStops === stops.length;
  const fromSha = reviewScope === "update" && update ? update.fromHeadSha : scopedEvidence.baseSha;
  return <div className="page page--brief">
    <div className="brief-hero">
      <div className="brief-hero__meta"><span className="avatar">{initials}</span><span><strong>{metadata.author.login}</strong> wants to merge</span><code>{metadata.head.ref}</code><Icon name="arrow-right" size={13} /><code>{metadata.base.ref}</code></div>
      <div className="brief-hero__title-row"><div><div className="eyebrow">Pull request #{metadata.number} · {reviewScope === "update" ? "since your review" : "entire PR"}</div><h1>{metadata.title}</h1></div><div className={`check-badge ${metadata.checks.failed ? "is-failed" : ""}`}><Icon name={metadata.checks.failed ? "flag" : "check"} size={15} /><span>{metadata.checks.total ? <><strong>{metadata.checks.passed}/{metadata.checks.total}</strong> checks passed</> : <><strong>None</strong> reported</>}</span></div></div>
      {update && <div className="acquired-scope"><button className={reviewScope === "update" ? "is-active" : ""} onClick={() => onScope("update")} type="button"><span>Since your review</span><b>{update.evidence.files.length}</b></button><button className={reviewScope === "full" ? "is-active" : ""} onClick={() => onScope("full")} type="button"><span>Entire PR</span><b>{session.evidence.files.length}</b></button></div>}
      <div className="brief-stats"><span><strong>{scopedEvidence.files.length}</strong> files</span><span><strong className="addition">+{scopedEvidence.additions}</strong><strong className="deletion">−{scopedEvidence.deletions}</strong> lines</span><span><strong>{metadata.commits.length}</strong> commits</span><span><code>{fromSha.slice(0, 7)}</code> → <code>{scopedEvidence.headSha.slice(0, 7)}</code></span></div>
    </div>
    {generated ? <>
      <section className="summary-findings">
        <header><div><div className="eyebrow">Findings · ranked by impact</div><h2>{blockingCount ? `${blockingCount} finding${blockingCount === 1 ? "" : "s"} to review before approval` : "No findings currently block approval"}</h2></div><span className={`summary-verdict ${blockingCount ? hasHighBlocker ? "is-high" : "" : "is-clear"}`}><Icon name={blockingCount ? "flag" : "check"} size={14} />{blockingCount ? "Review needed" : "Approval looks likely"}</span></header>
        {earlierFindings.length > 0 && <div className="summary-finding-group"><div className="summary-finding-group__label">Earlier findings</div><div className="summary-finding-list">{earlierFindings.map(({ prior, revision, stopIndex }, index) => <button aria-disabled={stopIndex < 0} className={stopIndex < 0 ? "is-static" : ""} key={prior.findingId} onClick={() => stopIndex >= 0 && onSelectStop(stopIndex)} type="button"><span className="finding-rank">{String(index + 1).padStart(2, "0")}</span><span className={`continuity-badge is-${revision.state}`}>{continuityLabel(revision.state)}</span><span><strong>{prior.title}</strong><small>{revision.summary}</small><em>{prior.severity} priority · from {baselineCheckpoint?.reviewedHeadSha.slice(0, 7)}</em></span>{stopIndex >= 0 && <Icon name="chevron-right" size={16} />}</button>)}</div></div>}
        {findings.length > 0 && <div className="summary-finding-group"><div className="summary-finding-group__label">New findings</div><div className="summary-finding-list">{findings.map(({ finding, stop, stopIndex }, index) => <button key={finding.id} onClick={() => onSelectStop(stopIndex)} type="button"><span className="finding-rank">{String(earlierFindings.length + index + 1).padStart(2, "0")}</span><span className={`risk-level risk-level--${finding.severity}`}>{finding.severity}</span><span><strong>{finding.title}</strong><small>{finding.body}</small><em>{finding.category} · {stop.title}</em></span><Icon name="chevron-right" size={16} /></button>)}</div></div>}
        {!earlierFindings.length && !findings.length && <div className="summary-clear"><Icon name="check" size={18} /><div><strong>Nothing in the analyzed evidence currently argues against approval.</strong><span>The guided route still provides a full-PR backstop.</span></div></div>}
      </section>
      <section className="summary-context"><div><span>{reviewScope === "update" ? "Update" : "Change"}</span><p>{generated.tour.summary}</p></div><div><span>Author intent</span><AuthorMarkdown fallback="No pull request description was provided." source={metadata.body} /></div></section>
      <section className="begin-card"><div><strong>{stops.length} review stop{stops.length === 1 ? "" : "s"}</strong><span>{stops.reduce((total, stop) => total + stop.minutes, 0)} min · pinned to {generated.headSha.slice(0, 7)}{generated.contextFingerprint ? ` · context ${generated.contextFingerprint.slice(0, 10)}` : ""}</span></div><button className="button button--hero" onClick={onBegin} type="button">Start review <Icon name="arrow-right" /></button></section>
      <section className="checkpoint-card"><div><span className={`card-icon ${checkpoint ? "" : "card-icon--spark"}`}><Icon name={checkpoint ? "check" : "shield"} size={17} /></span><div><strong>{checkpoint ? `Reviewed at ${checkpoint.reviewedHeadSha.slice(0, 7)}` : allReviewed ? "Ready to save this review point" : `${stops.length - reviewedStops} stop${stops.length - reviewedStops === 1 ? "" : "s"} remaining`}</strong><span>{checkpoint ? "Check whether the author has pushed anything new." : allReviewed ? "Future update reviews will begin from this exact head." : "Review every stop before creating the update baseline."}</span></div></div>{checkpoint ? <button className="button button--secondary" disabled={refreshing} onClick={onCheckUpdates} type="button">{refreshing ? "Checking…" : "Check for updates"}<Icon name="arrow-right" size={14} /></button> : <button className="button button--secondary" disabled={!allReviewed || completing} onClick={onComplete} type="button">{completing ? "Saving…" : "Complete review"}<Icon name="check" size={14} /></button>}</section>
    </> : <>
      <section className="summary-findings acquired-evidence-ready"><header><div><div className="eyebrow">Evidence ready</div><h2>The pull request is pinned and ready for a guided review</h2></div><span className="summary-verdict"><Icon name="code" size={14} />{tourLoading ? "Checking" : "Not analyzed"}</span></header><div className="summary-clear"><Icon name="check" size={18} /><div><strong>{session.evidence.files.length} changed file{session.evidence.files.length === 1 ? "" : "s"} passed anchor validation.</strong><span>Generate a semantic route with {activeModel}, or inspect the diff directly.</span></div></div></section>
      {metadata.body && <section className="summary-context acquired-description"><div><span>Author description</span><AuthorMarkdown source={metadata.body} /></div></section>}
      {error && <div className="target-error acquired-generation-error" role="alert"><Icon name="flag" size={14} />{error}</div>}
      <section className="begin-card"><div><strong>{modelReady ? activeModel : "Choose a configured model"}</strong><span>Analysis stays inside the local Wingdiff process</span></div><div className="acquired-start-actions"><button className="button button--quiet" onClick={onBrowse} type="button">Browse diff</button><button className="button button--hero" disabled={tourLoading || generating} onClick={onGenerate} type="button">{generating ? "Building tour…" : modelReady ? "Generate guided review" : "Choose model"} <Icon name="arrow-right" /></button></div></section>
    </>}
    {notice && <div className="review-notice" role="status"><Icon name="check" size={14} />{notice}</div>}
    {generated && error && <div className="target-error acquired-generation-error" role="alert"><Icon name="flag" size={14} />{error}</div>}
  </div>;
}

function AcquiredTourRail({ activeIndex, inheritedStopIds, onBrowse, onReview, onSelect, onSummary, statuses, stops }: { activeIndex: number; inheritedStopIds: Set<string>; onBrowse: () => void; onReview: () => void; onSelect: (index: number) => void; onSummary: () => void; statuses: Record<string, StopStatus>; stops: TourStop[] }) {
  const completed = stops.filter((stop) => statuses[stop.id] !== undefined && statuses[stop.id] !== "unseen").length;
  const progress = Math.round((completed / stops.length) * 100);
  return <aside className="tour-rail"><div className="tour-rail__heading"><span>Review route</span><span>{stops.reduce((total, stop) => total + stop.minutes, 0)} min</span></div><nav aria-label="Review route" className="route-list"><button className="route-item route-item--brief" onClick={onSummary} type="button"><span className="route-item__marker"><Icon name="layers" size={14} /></span><span><strong>Summary</strong><small>Findings and intent</small></span></button><div className="route-list__line" />{stops.map((stop, index) => { const status = statuses[stop.id] ?? "unseen"; return <button className={`route-item ${activeIndex === index ? "is-active" : ""} is-${status}`} key={stop.id} onClick={() => onSelect(index)} type="button"><span className="route-item__marker">{status === "understood" ? <Icon name="check" size={13} /> : status === "flagged" ? <Icon name="flag" size={12} /> : index + 1}</span><span><strong>{stop.eyebrow}</strong><small>{shortTitle(stop.title)}</small></span>{stop.finding ? <i className={`severity-dot severity-dot--${stop.finding.severity}`} /> : status === "unseen" && inheritedStopIds.has(stop.id) ? <span className="coverage-mark">reviewed unchanged</span> : null}</button>; })}<div className="route-list__line route-list__line--last" /><button className="route-item" onClick={onBrowse} type="button"><span className="route-item__marker"><Icon name="code" size={14} /></span><span><strong>Changed files</strong><small>Browse full diff</small></span></button><button className="route-item route-item--review" onClick={onReview} type="button"><span className="route-item__marker"><Icon name="shield" size={14} /></span><span><strong>Review desk</strong><small>Prepare your decision</small></span></button></nav><div className="rail-progress"><div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><span>{progress}%</span></div><div><strong>{completed} of {stops.length}</strong><span>stops reviewed</span></div></div></aside>;
}

function AcquiredTourView({ activeEvidence, activeEvidenceId, activeFindingRevisions, activeIndex, comments, headSha, onAsk, onComment, onEvidence, onFindingComment, onFlag, onNavigate, onSelectLine, onUnderstood, selection, status, stop, totalStops }: {
  activeEvidence: EvidenceBlock;
  activeEvidenceId: string | null;
  activeFindingRevisions: Array<{ prior: FindingCheckpoint; revision: GeneratedSessionTour["tour"]["findingRevisions"][number] }>;
  activeIndex: number;
  comments: number;
  headSha: string;
  onAsk: (prompt?: string) => void;
  onComment: () => void;
  onEvidence: (id: string) => void;
  onFindingComment: () => void;
  onFlag: () => void;
  onNavigate: (delta: number) => void;
  onSelectLine: (evidenceId: string, line: number, side: "LEFT" | "RIGHT", extend: boolean) => void;
  onUnderstood: () => void;
  selection: Selection | null;
  status: StopStatus;
  stop: TourStop;
  totalStops: number;
}) {
  return <div className="page page--tour" key={stop.id}>
    <header className="stop-header"><div className="stop-header__topline"><div className="eyebrow">{activeIndex + 1}/{totalStops} · {stop.eyebrow}</div></div><h1>{stop.title}</h1><p>{stop.summary}</p><div className="stop-actions"><button className="button button--quiet" onClick={() => onAsk()} type="button"><Icon name="spark" size={15} />Ask</button><button className={`button button--quiet ${status === "flagged" ? "is-flagged" : ""}`} onClick={onFlag} type="button"><Icon name="flag" size={15} />{status === "flagged" ? "Flagged" : "Flag"}</button><button className="button button--secondary" onClick={onComment} type="button"><Icon name="comment" size={15} />Comment</button>{comments > 0 && <span className="draft-count">{comments} draft</span>}</div></header>
    <div className="tour-grid">
      <section className="evidence-column"><div className="section-label"><span>Code change</span><button type="button"><Icon name="code" size={13} /> {headSha.slice(0, 7)}</button></div>{stop.evidence.length > 1 && <div className="evidence-tabs">{stop.evidence.map((item) => <button className={item.id === activeEvidenceId ? "is-active" : ""} key={item.id} onClick={() => onEvidence(item.id)} type="button">{item.label}<span>{fileName(item.path)}</span></button>)}</div>}<CodeDiff evidence={activeEvidence} onAsk={() => onAsk()} onComment={onComment} onSelectLine={onSelectLine} selection={selection} /></section>
      <aside className="insight-column">
        <section className="insight-section finding-section">
          <div className="section-label"><span>{activeFindingRevisions.length || stop.finding ? "Review findings" : "Review finding"}</span></div>
          {activeFindingRevisions.map(({ prior, revision }) => <article className={`continuity-card is-${revision.state}`} key={prior.findingId}><header><span className={`continuity-badge is-${revision.state}`}>{continuityLabel(revision.state)}</span><span>{prior.severity} priority</span></header><h3>{prior.title}</h3><p>{revision.summary}</p></article>)}
          {stop.finding ? <article className={`finding-card finding-card--${stop.finding.severity}`}><header><span className={`risk-level risk-level--${stop.finding.severity}`}>{stop.finding.severity}</span><span>{stop.finding.category}</span></header><h3>{stop.finding.title}</h3><p>{stop.finding.body}</p><button className="button button--finding" onClick={onFindingComment} type="button"><Icon name="comment" size={14} /> Draft from finding</button></article> : !activeFindingRevisions.length && <article className="finding-clear"><span><Icon name="check" size={17} /></span><div><h3>No blocking finding here</h3><p>Nothing in this stop currently argues against approval.</p></div></article>}
        </section>
        <section className="insight-section"><div className="section-label"><span>Observations</span></div><div className="observation-list">{stop.claims.map((claim) => <article className={`observation observation--${claim.kind}`} key={claim.id}><header><span>{claimKindLabel(claim.kind)}</span><small>{claim.confidence} confidence</small></header><p>{claim.text}</p><button type="button"><Icon name="code" size={13} /> {claim.evidenceIds.length} code anchor{claim.evidenceIds.length === 1 ? "" : "s"}</button></article>)}</div></section>
        {stop.prompts.length > 0 && <section className="insight-section review-prompts"><div className="section-label"><span>Questions to verify</span></div>{stop.prompts.map((prompt, index) => <button className="acquired-prompt" key={prompt} onClick={() => onAsk(prompt)} type="button"><span>{String(index + 1).padStart(2, "0")}</span>{prompt}</button>)}</section>}
      </aside>
    </div>
    <footer className="stop-footer"><button aria-label="Previous stop" className="button button--quiet" disabled={activeIndex === 0} onClick={() => onNavigate(-1)} type="button"><Icon name="arrow-left" size={16} /> Previous</button><span>{status === "understood" ? "Marked understood" : status === "flagged" ? "Flagged for review" : "Ready for your judgment"}</span><button className="button button--complete" onClick={onUnderstood} type="button"><Icon name="check" size={16} />{activeIndex === totalStops - 1 ? "Mark understood & finish" : "Mark understood"}<Icon name="arrow-right" size={16} /></button></footer>
  </div>;
}

function AcquiredBrowse({ blocks, onSummary, scope, session }: { blocks: EvidenceBlock[]; onSummary: () => void; scope: AcquiredScope; session: AcquiredReviewSession }) {
  return <div className="page page--browse"><header className="browse-header"><div><div className="eyebrow">{scope === "update" ? "Since your review" : "Entire PR"} · {session.metadata.head.sha.slice(0, 7)}</div><h1>Changed files</h1><p>{scope === "update" ? "Only code changed after your explicit review checkpoint." : "The full pull request diff remains available as a backstop."}</p></div><button className="button button--secondary" onClick={onSummary} type="button"><Icon name="arrow-left" size={16} /> Back to summary</button></header><div className="browse-layout"><aside className="file-index"><div className="section-label"><span>Changed files</span><b>{blocks.length}</b></div>{blocks.map((block) => <a href={`#${block.id}`} key={block.id}><Icon name="code" size={14} /><span>{fileName(block.path)}<small>{directoryName(block.path)}</small></span><Icon name="chevron-right" size={13} /></a>)}</aside><div className="browse-diffs">{blocks.map((block) => <div className="browse-file" id={block.id} key={block.id}><CodeDiff evidence={block} minimal /></div>)}</div></div></div>;
}

function AcquiredReviewDesk({ comments, disposition, error, failedChecks, headSha, highFindingCount, onAllowRetry, onBack, onDisposition, onPublish, onRemoveComment, onSave, onSummary, publication, publishing, saving, statuses, stops, submission, summary }: {
  comments: DraftComment[];
  disposition: ReviewDisposition;
  error: string | null;
  failedChecks: number;
  headSha: string;
  highFindingCount: number;
  onAllowRetry: () => void;
  onBack: () => void;
  onDisposition: (value: ReviewDisposition) => void;
  onPublish: (acknowledgeApprovalRisks: boolean) => void;
  onRemoveComment: (id: string) => void;
  onSave: () => void;
  onSummary: (value: string) => void;
  publication: StoredReviewPublication | null;
  publishing: boolean;
  saving: boolean;
  statuses: Record<string, StopStatus>;
  stops: TourStop[];
  submission: StoredReviewSubmission | null;
  summary: string;
}) {
  const reviewed = stops.filter((stop) => (statuses[stop.id] ?? "unseen") !== "unseen").length;
  const flagged = stops.filter((stop) => statuses[stop.id] === "flagged").length;
  const [approvalAcknowledged, setApprovalAcknowledged] = useState(false);
  const rankedComments = [...comments].sort((left, right) => compareSeverity(left.severity, right.severity) || left.path.localeCompare(right.path));
  const approvalRisks = [
    ...(reviewed < stops.length ? [`${stops.length - reviewed} review stop${stops.length - reviewed === 1 ? " is" : "s are"} still unseen.`] : []),
    ...(flagged ? [`${flagged} review stop${flagged === 1 ? " remains" : "s remain"} flagged.`] : []),
    ...(highFindingCount ? [`${highFindingCount} high-severity finding${highFindingCount === 1 ? " remains" : "s remain"}.`] : []),
    ...(failedChecks ? [`${failedChecks} required check${failedChecks === 1 ? " is" : "s are"} failing.`] : []),
  ];
  const needsApprovalAcknowledgement = disposition === "APPROVE" && approvalRisks.length > 0;
  const hasPublishContent = disposition === "APPROVE" ? Boolean(summary.trim() || comments.length) : Boolean(summary.trim());
  const canPublish = hasPublishContent && !publication && (!needsApprovalAcknowledgement || approvalAcknowledged);

  return <div className="page page--review">
    <header className="review-header"><button className="back-link" onClick={onBack} type="button"><Icon name="arrow-left" size={15} /> Back to review</button><div className="eyebrow">Review desk</div><h1>Prepare your decision.</h1><p>Confirm the feedback and disposition that will represent your review.</p></header>
    <div className="review-summary-strip"><div><span className="summary-icon summary-icon--green"><Icon name="check" /></span><span><strong>{reviewed}/{stops.length}</strong><small>stops reviewed</small></span></div><div><span className="summary-icon summary-icon--amber"><Icon name="flag" /></span><span><strong>{flagged}</strong><small>open flag{flagged === 1 ? "" : "s"}</small></span></div><div><span className="summary-icon summary-icon--blue"><Icon name="comment" /></span><span><strong>{comments.length}</strong><small>draft comment{comments.length === 1 ? "" : "s"}</small></span></div><div className="review-sha"><span className="live-dot" /><span><strong>Pinned head</strong><small>{headSha.slice(0, 12)}</small></span></div></div>
    {error && <div className="target-error acquired-generation-error" role="alert"><Icon name="flag" size={14} />{error}</div>}
    <div className="review-grid"><div className="review-main"><section className="review-section"><header><div><span>01</span><div><h2>Review summary</h2><p>Keep it concise and decision-relevant.</p></div></div><small>{summary.length} characters</small></header><textarea disabled={Boolean(submission)} onBlur={onSave} onChange={(event) => onSummary(event.target.value)} placeholder="Summarize your review…" rows={6} value={summary} /></section><section className="review-section"><header><div><span>02</span><div><h2>Inline comments</h2><p>Ranked by severity and pinned to the diff.</p></div></div><small>{comments.length} draft{comments.length === 1 ? "" : "s"}</small></header>{rankedComments.length === 0 ? <div className="empty-comments"><Icon name="comment" /><strong>No inline comments</strong><span>A summary-only review is valid.</span></div> : <div className="review-comments">{rankedComments.map((comment) => <article key={comment.id}><header><span className={`risk-level risk-level--${comment.severity}`}>{comment.severity}</span><code>{comment.path}:{comment.startLine}{comment.endLine !== comment.startLine ? `–${comment.endLine}` : ""}</code>{!submission && <button aria-label="Remove draft comment" onClick={() => onRemoveComment(comment.id)} type="button"><Icon name="x" size={15} /></button>}</header><p>{comment.body}</p></article>)}</div>}</section></div><aside className="publish-card"><div className="eyebrow">Final disposition</div><h2>{submission ? "Review published" : "How should GitHub record this review?"}</h2>{submission ? <div className="submitted-review"><span className="summary-icon summary-icon--green"><Icon name="check" /></span><div><strong>{labelDisposition(submission.event)}</strong><small>{new Date(submission.submittedAt).toLocaleString()}</small></div></div> : <div className="disposition-list">{(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as ReviewDisposition[]).map((value) => <button className={disposition === value ? "is-active" : ""} key={value} onClick={() => { setApprovalAcknowledged(false); onDisposition(value); }} type="button"><span className="radio"><i /></span><span><strong>{labelDisposition(value)}</strong><small>{dispositionDescription(value)}</small></span></button>)}</div>}{needsApprovalAcknowledgement && !submission && <div className="approval-warning"><strong>Approval needs acknowledgement</strong><ul>{approvalRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul><label><input checked={approvalAcknowledged} onChange={(event) => setApprovalAcknowledged(event.target.checked)} type="checkbox" />I reviewed these signals and still intend to approve.</label></div>}{publication && !submission && <div className="publication-warning"><strong>{publication.state === "publishing" ? "Publication is already in progress" : "Publication outcome is uncertain"}</strong><p>{publication.state === "publishing" ? "Another request currently owns this publication." : "Check the pull request on GitHub before retrying. The prior request may have succeeded without returning a receipt."}</p>{publication.state === "uncertain" && <button className="button button--quiet button--small" onClick={onAllowRetry} type="button">I verified GitHub · allow retry</button>}</div>}<div className="publish-preview"><span>{submission ? "Sent to GitHub" : "Will publish"}</span><strong>{comments.length} inline comment{comments.length === 1 ? "" : "s"}</strong><strong>{summary.trim() ? "1 review summary" : "No review summary"}</strong><small>{headSha.slice(0, 12)}</small></div>{submission ? <a className="button button--publish" href={submission.url} rel="noreferrer" target="_blank">Open on GitHub <Icon name="external" size={16} /></a> : <><button className="button button--publish" disabled={!canPublish || publishing || saving} onClick={() => onPublish(approvalAcknowledged)} type="button">{publishing ? "Revalidating…" : "Publish review to GitHub"}<Icon name="external" size={16} /></button><p className="publish-note"><Icon name="shield" size={13} /> Head and line anchors are revalidated before publishing.</p></>}</aside></div>
  </div>;
}

function ReviewApp({ onHome }: { onHome: () => void }) {
  const [view, setView] = useState<View>("brief");
  const [reviewMode, setReviewMode] = useState<ReviewMode>("update");
  const [activeIndex, setActiveIndex] = useState(0);
  const [statuses, setStatuses] = usePersistentState(`wingdiff:statuses:${pullRequest.headSha}`, initialStatuses);
  const [comments, setComments] = usePersistentState<DraftComment[]>(`wingdiff:comments:${pullRequest.headSha}`, []);
  const [notebook, setNotebook] = usePersistentState<NotebookEntry[]>(`wingdiff:notebook:${pullRequest.headSha}`, []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null);
  const tourCanvasRef = useRef<HTMLElement>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [question, setQuestion] = useState("");
  const [answering, setAnswering] = useState(false);
  const [providers, setProviders] = useState<ProviderDefinition[]>(FALLBACK_PROVIDERS);
  const [modelSelection, setModelSelection] = usePersistentState<ModelSelection>("wingdiff:model", DEFAULT_SELECTION);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [theme, setTheme] = usePersistentState<"dark" | "light">("wingdiff:theme", "dark");
  const [reviewSummary, setReviewSummary] = useState(
    "The follow-up makes the Redis counter update atomic and adds concurrent regression coverage. I found no remaining blocking issues.",
  );
  const [disposition, setDisposition] = useState<ReviewDisposition>("COMMENT");
  const [toast, setToast] = useState<string | null>(null);

  const activeStops = reviewMode === "update" ? updateStops : tourStops;
  const activeStop = activeStops[activeIndex]!;
  const completedCount = activeStops.filter((stop) => statuses[stop.id] !== "unseen").length;
  const understoodCount = tourStops.filter((stop) => statuses[stop.id] === "understood").length;
  const activeEvidence = activeStop.evidence.find((item) => item.id === activeEvidenceId) ?? activeStop.evidence[0]!;
  const stopNotebook = notebook.filter((entry) => entry.stopId === activeStop.id);
  const activeModel = selectedModel(providers, modelSelection);
  const activeProvider = providers.find((provider) => provider.id === modelSelection.provider);
  const activeModelLabel = activeProvider ? `${activeProvider.name} · ${activeModel.name}` : activeModel.name;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const controller = new AbortController();
    fetchProviders(controller.signal).then((availableProviders) => {
      setProviders(availableProviders);
      setModelSelection((current) => {
        const currentProvider = availableProviders.find((provider) => provider.id === current.provider);
        if (currentProvider?.configured) return current;
        const codex = availableProviders.find((provider) => provider.id === "codex" && provider.configured);
        const model = codex?.models.find((candidate) => candidate.id === DEFAULT_SELECTION.model) ?? codex?.models[0];
        return codex && model
          ? { provider: codex.id, model: model.id, reasoningEffort: model.defaultEffort }
          : current;
      });
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    setActiveEvidenceId(activeStop.evidence[0]?.id ?? null);
    setSelection(null);
  }, [activeStop]);

  useEffect(() => {
    if (view === "tour") tourCanvasRef.current?.scrollTo({ top: 0 });
  }, [activeIndex, reviewMode, view]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea, [contenteditable='true']")) return;

      if (event.key === "j" && view === "tour") navigateStop(1);
      if (event.key === "k" && view === "tour") navigateStop(-1);
      if (event.key === "a" && view === "tour") setDrawerOpen(true);
      if (event.key === "c" && view === "tour") openComment();
      if (event.key === "f" && view === "tour") toggleFlag();
      if (event.key === "d") setView((current) => current === "browse" ? "tour" : "browse");
      if (event.key === "r") setView("review");
      if (event.key === "Escape") {
        setDrawerOpen(false);
        setComposer(null);
        setMobileNavOpen(false);
        setModelPickerOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  function selectStop(index: number) {
    setActiveIndex(index);
    setView("tour");
    setMobileNavOpen(false);
  }

  function selectReviewMode(mode: ReviewMode) {
    setReviewMode(mode);
    setActiveIndex(0);
    setSelection(null);
  }

  function selectFullStop(index: number) {
    setReviewMode("full");
    setActiveIndex(index);
    setView("tour");
    setMobileNavOpen(false);
  }

  function navigateStop(delta: number) {
    setActiveIndex((current) => Math.max(0, Math.min(activeStops.length - 1, current + delta)));
  }

  function markUnderstoodAndAdvance() {
    setStatuses((current) => ({ ...current, [activeStop.id]: "understood" }));
    if (activeIndex === activeStops.length - 1) {
      setView("review");
    } else {
      navigateStop(1);
    }
  }

  function toggleFlag() {
    setStatuses((current) => ({
      ...current,
      [activeStop.id]: current[activeStop.id] === "flagged" ? "unseen" : "flagged",
    }));
  }

  function selectLine(evidenceId: string, line: number, side: "LEFT" | "RIGHT", extend: boolean) {
    setSelection((current) => {
      if (!extend || !current || current.evidenceId !== evidenceId || current.side !== side) {
        return { evidenceId, side, start: line, end: line };
      }
      return { ...current, end: line };
    });
  }

  function openComment(useFinding = false, initialBody = "", preferredEvidenceId?: string) {
    const preferredEvidence = activeStop.evidence.find((item) => item.id === preferredEvidenceId);
    const selectedEvidence = activeStop.evidence.find((item) => item.id === selection?.evidenceId);
    const findingEvidence = activeStop.evidence.find((item) => item.id === activeStop.finding?.evidenceId);
    const evidence = preferredEvidence ?? selectedEvidence ?? (useFinding ? findingEvidence : activeEvidence) ?? activeEvidence;
    const start = selection?.evidenceId === evidence.id
      ? Math.min(selection.start, selection.end)
      : evidence.startLine;
    const end = selection?.evidenceId === evidence.id
      ? Math.max(selection.start, selection.end)
      : evidence.endLine;
    setComposer({
      stop: activeStop,
      evidence,
      startLine: start,
      endLine: end,
      body: initialBody || (useFinding ? activeStop.finding?.suggestedComment ?? "" : ""),
      severity: useFinding ? activeStop.finding?.severity ?? "medium" : "low",
    });
  }

  function stageComment() {
    if (!composer?.body.trim()) return;
    setComments((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        stopId: composer.stop.id,
        evidenceId: composer.evidence.id,
        path: composer.evidence.path,
        startLine: composer.startLine,
        endLine: composer.endLine,
        body: composer.body.trim(),
        severity: composer.severity,
      },
    ]);
    setComposer(null);
    setToast("Draft comment added to your review");
    window.setTimeout(() => setToast(null), 2600);
  }

  async function askQuestion(prompt?: string) {
    const value = (prompt ?? question).trim();
    if (!value || answering) return;
    setQuestion("");
    setAnswering(true);
    const entryId = crypto.randomUUID();
    const live = Boolean(activeProvider?.configured);
    const entry: NotebookEntry = {
      id: entryId,
      stopId: activeStop.id,
      question: value,
      answer: "",
      createdAt: Date.now(),
      provider: live ? modelSelection.provider : "fixture",
      model: live ? activeModelLabel : "Guided fixture",
      status: "streaming",
    };
    setNotebook((current) => [...current, entry]);

    if (!live) {
      window.setTimeout(() => {
        updateNotebookEntry(setNotebook, entryId, {
          answer: mockAnswers[activeStop.id] ?? "The available evidence does not resolve that question yet.",
          status: "complete",
        });
        setAnswering(false);
      }, 650);
      return;
    }

    try {
      await streamInvestigation({
        selection: modelSelection,
        stop: activeStop,
        question: value,
        onDelta: (delta) => setNotebook((current) => current.map((item) => item.id === entryId ? { ...item, answer: item.answer + delta } : item)),
      });
      updateNotebookEntry(setNotebook, entryId, { status: "complete" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The model request failed.";
      updateNotebookEntry(setNotebook, entryId, {
        answer: `Wingdiff could not complete this investigation. ${message}`,
        status: "error",
      });
    } finally {
      setAnswering(false);
    }
  }

  function beginTour() {
    setActiveIndex(0);
    setView("tour");
  }

  return (
    <div className="app-shell">
      <TopBar
        activeModel={activeModelLabel}
        comments={comments.length}
        onHome={onHome}
        onMenu={() => setMobileNavOpen((open) => !open)}
        onModel={() => setModelPickerOpen(true)}
        onReview={() => setView("review")}
        onTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        providerConfigured={Boolean(activeProvider?.configured)}
        theme={theme}
      />

      <div className="workspace">
        <TourRail
          activeIndex={activeIndex}
          comments={comments.length}
          completed={completedCount}
          mobileOpen={mobileNavOpen}
          onBrief={() => { setView("brief"); setMobileNavOpen(false); }}
          onReview={() => { setView("review"); setMobileNavOpen(false); }}
          onReviewMode={selectReviewMode}
          onSelectStop={selectStop}
          reviewMode={reviewMode}
          stops={activeStops}
          statuses={statuses}
          view={view}
        />

        <main className="main-canvas" ref={tourCanvasRef}>
          {view === "brief" && <Summary onBegin={beginTour} onReviewMode={selectReviewMode} onSelectStop={selectStop} reviewMode={reviewMode} />}
          {view === "tour" && (
            <TourView
              activeEvidence={activeEvidence}
              activeEvidenceId={activeEvidenceId}
              activeIndex={activeIndex}
              comments={comments.filter((comment) => comment.stopId === activeStop.id).length}
              onAsk={() => setDrawerOpen(true)}
              onComment={() => openComment(false)}
              onEvidence={setActiveEvidenceId}
              onFindingComment={() => openComment(true)}
              onFlag={toggleFlag}
              onNavigate={navigateStop}
              onSelectLine={selectLine}
              onUnderstood={markUnderstoodAndAdvance}
              reviewMode={reviewMode}
              selection={selection}
              status={statuses[activeStop.id] ?? "unseen"}
              stop={activeStop}
              totalStops={activeStops.length}
              findingRevision={reviewMode === "update" ? reviewUpdate.findingRevisions.find((revision) => revision.stopId === activeStop.id) : undefined}
            />
          )}
          {view === "browse" && (
            <BrowseView
              onAsk={(index) => { selectFullStop(index); setDrawerOpen(true); }}
              onReturn={() => setView("tour")}
              onSelectStop={selectFullStop}
            />
          )}
          {view === "review" && (
            <ReviewDesk
              comments={comments}
              disposition={disposition}
              onBack={() => setView("tour")}
              onDisposition={setDisposition}
              onPublish={() => {
                setToast(`Review ready to publish as ${labelDisposition(disposition)}`);
                window.setTimeout(() => setToast(null), 3200);
              }}
              onRemoveComment={(id) => setComments((current) => current.filter((comment) => comment.id !== id))}
              onSummary={setReviewSummary}
              statuses={statuses}
              summary={reviewSummary}
              understood={understoodCount}
            />
          )}
        </main>
      </div>

      {drawerOpen && (
        <InvestigationDrawer
          answering={answering}
          entries={stopNotebook}
          evidence={activeEvidence}
          headSha={pullRequest.headSha}
          modelName={activeModelLabel}
          onAsk={askQuestion}
          onClose={() => setDrawerOpen(false)}
          onQuestion={setQuestion}
          onUseAnswer={(entry) => { openComment(false, entry.answer, entry.evidenceId); setDrawerOpen(false); }}
          question={question}
          providerConfigured={Boolean(activeProvider?.configured)}
          stop={activeStop}
        />
      )}

      {modelPickerOpen && (
        <ModelPicker
          onClose={() => setModelPickerOpen(false)}
          onSelection={setModelSelection}
          providers={providers}
          selection={modelSelection}
        />
      )}

      {composer && (
        <CommentComposer
          composer={composer}
          onCancel={() => setComposer(null)}
          onChange={(body) => setComposer((current) => current ? { ...current, body } : null)}
          onSeverity={(severity) => setComposer((current) => current ? { ...current, severity } : null)}
          onStage={stageComment}
        />
      )}

      {toast && <div className="toast" role="status"><Icon name="check" size={16} />{toast}</div>}
    </div>
  );
}

function TopBar({ activeModel, comments, onHome, onMenu, onModel, onReview, onTheme, providerConfigured, theme }: { activeModel: string; comments: number; onHome: () => void; onMenu: () => void; onModel: () => void; onReview: () => void; onTheme: () => void; providerConfigured: boolean; theme: "dark" | "light" }) {
  return (
    <header className="topbar">
      <button aria-label="Open navigation" className="icon-button mobile-menu" onClick={onMenu} type="button"><Icon name="menu" /></button>
      <div className="brand"><span className="brand__mark"><Icon name="route" size={19} /></span><span>wingdiff</span></div>
      <div className="topbar__divider" />
      <button className="home-button" onClick={onHome} type="button"><Icon name="arrow-left" size={14} /><span>New review</span></button>
      <div className="pr-identity"><span>{pullRequest.repository}</span><strong>#{pullRequest.number}</strong><span className="pr-identity__title">{pullRequest.title}</span></div>
      <div className="topbar__spacer" />
      <button className="model-button" onClick={onModel} type="button">
        <span className="model-button__spark"><Icon name="spark" size={13} /></span>
        <span><small>{providerConfigured ? "Live model" : "Fixture mode"}</small><strong>{activeModel}</strong></span>
        <Icon name="chevron-right" size={13} />
      </button>
      <button aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`} className="icon-button" onClick={onTheme} type="button"><Icon name={theme === "dark" ? "sun" : "moon"} size={17} /></button>
      <button className="button button--primary topbar__review" onClick={onReview} type="button">Review {comments > 0 && <span>{comments}</span>}</button>
    </header>
  );
}

function TourRail({ activeIndex, comments, completed, mobileOpen, onBrief, onReview, onReviewMode, onSelectStop, reviewMode, statuses, stops, view }: { activeIndex: number; comments: number; completed: number; mobileOpen: boolean; onBrief: () => void; onReview: () => void; onReviewMode: (mode: ReviewMode) => void; onSelectStop: (index: number) => void; reviewMode: ReviewMode; statuses: Record<string, StopStatus>; stops: TourStop[]; view: View }) {
  const progress = Math.round((completed / stops.length) * 100);
  return (
    <aside className={`tour-rail ${mobileOpen ? "is-open" : ""}`}>
      <div className="tour-rail__heading"><span>Review route</span><span>{stops.reduce((total, stop) => total + stop.minutes, 0)} min</span></div>
      <ReviewScope mode={reviewMode} onChange={onReviewMode} compact />
      <nav aria-label="Review route" className="route-list">
        <button className={`route-item route-item--brief ${view === "brief" ? "is-active" : ""}`} onClick={onBrief} type="button"><span className="route-item__marker"><Icon name="layers" size={14} /></span><span><strong>Summary</strong><small>{reviewMode === "update" ? "What changed" : "Entire pull request"}</small></span></button>
        <div className="route-list__line" />
        {stops.map((stop, index) => {
          const status = statuses[stop.id] ?? "unseen";
          const revision = reviewUpdate.findingRevisions.find((item) => item.stopId === stop.id);
          return <button className={`route-item ${view === "tour" && activeIndex === index ? "is-active" : ""} is-${status}`} key={stop.id} onClick={() => onSelectStop(index)} type="button"><span className="route-item__marker">{status === "understood" ? <Icon name="check" size={13} /> : status === "flagged" ? <Icon name="flag" size={12} /> : index + 1}</span><span><strong>{stop.eyebrow}</strong><small>{shortTitle(stop.title)}</small></span>{stop.finding ? <i className={`severity-dot severity-dot--${stop.finding.severity}`} /> : reviewMode === "update" && revision ? <Icon name="check" size={13} /> : reviewMode === "full" && reviewUpdate.unchangedStopIds.includes(stop.id) ? <span className="coverage-mark">unchanged</span> : null}</button>;
        })}
        <div className="route-list__line route-list__line--last" />
        <button className={`route-item route-item--review ${view === "review" ? "is-active" : ""}`} onClick={onReview} type="button"><span className="route-item__marker"><Icon name="shield" size={14} /></span><span><strong>Review desk</strong><small>{comments} draft comment{comments === 1 ? "" : "s"}</small></span></button>
      </nav>
      <div className="rail-progress"><div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><span>{progress}%</span></div><div><strong>{completed} of {stops.length}</strong><span>stops reviewed</span></div></div>
      <div className="rail-shortcuts"><kbd>J</kbd><kbd>K</kbd><span>to navigate</span><button type="button">?</button></div>
    </aside>
  );
}

function ReviewScope({ compact = false, mode, onChange }: { compact?: boolean; mode: ReviewMode; onChange: (mode: ReviewMode) => void }) {
  return <div className={`review-scope ${compact ? "review-scope--compact" : ""}`}><button className={mode === "update" ? "is-active" : ""} onClick={() => onChange("update")} type="button"><span>Since your review</span><b>{updateStops.length}</b></button><button className={mode === "full" ? "is-active" : ""} onClick={() => onChange("full")} type="button"><span>Entire PR</span><b>{tourStops.length}</b></button></div>;
}

function Summary({ onBegin, onReviewMode, onSelectStop, reviewMode }: { onBegin: () => void; onReviewMode: (mode: ReviewMode) => void; onSelectStop: (index: number) => void; reviewMode: ReviewMode }) {
  const isUpdate = reviewMode === "update";
  const activeStops = isUpdate ? updateStops : tourStops;
  return (
    <div className="page page--brief">
      <div className="brief-hero">
        <div className="brief-hero__meta"><span className="avatar">{pullRequest.authorInitials}</span><span><strong>{pullRequest.author}</strong> wants to merge</span><code>{pullRequest.branch}</code><Icon name="arrow-right" size={13} /><code>{pullRequest.base}</code></div>
        <div className="brief-hero__title-row"><div><div className="eyebrow">Pull request #{pullRequest.number} · summary</div><h1>{pullRequest.title}</h1></div><div className="check-badge"><Icon name="check" size={15} /><span><strong>{pullRequest.checks.passed}/{pullRequest.checks.total}</strong> checks passed</span></div></div>
        <ReviewScope mode={reviewMode} onChange={onReviewMode} />
        <div className="brief-stats">{isUpdate ? <><span><code>{reviewUpdate.fromHeadSha}</code> → <code>{reviewUpdate.toHeadSha}</code></span><span><strong>{reviewUpdate.filesChanged}</strong> files</span><span><strong className="addition">+{reviewUpdate.additions}</strong><strong className="deletion">−{reviewUpdate.deletions}</strong> lines</span><span><strong>{reviewUpdate.commits}</strong> new commits</span><span><strong>{reviewUpdate.unchangedStopIds.length}</strong> areas unchanged</span></> : <><span><strong>{pullRequest.filesChanged}</strong> files</span><span><strong className="addition">+{pullRequest.additions}</strong><strong className="deletion">−{pullRequest.deletions}</strong> lines</span><span><strong>{pullRequest.commits}</strong> commits</span><span><strong>{pullRequest.estimatedMinutes} min</strong> guided review</span><span><code>{pullRequest.headSha}</code> analyzed</span></>}</div>
      </div>
      <section className="summary-findings">
        <header>
          <div><div className="eyebrow">{isUpdate ? "Earlier findings" : "Findings · ranked by impact"}</div><h2>{isUpdate ? "Both earlier findings appear addressed" : rankedFindings.length ? `${rankedFindings.length} finding${rankedFindings.length === 1 ? "" : "s"} to review before approval` : "No findings currently block approval"}</h2></div>
          <span className="summary-verdict is-clear"><Icon name="check" size={14} />Approval looks likely</span>
        </header>
        {isUpdate ? <div className="summary-finding-list">{reviewUpdate.findingRevisions.map((finding, index) => <button key={finding.findingId} onClick={() => onSelectStop(updateStops.findIndex((stop) => stop.id === finding.stopId))} type="button"><span className="finding-rank">{String(index + 1).padStart(2, "0")}</span><span className="resolution-badge"><Icon name="check" size={12} />addressed</span><span><strong>{finding.title}</strong><small>{finding.summary}</small><em>{finding.severity} priority · recheck</em></span><Icon name="chevron-right" size={16} /></button>)}</div> : rankedFindings.length ? <div className="summary-finding-list">{rankedFindings.map(({ finding, stop, stopIndex }, index) => <button key={finding.id} onClick={() => onSelectStop(stopIndex)} type="button"><span className="finding-rank">{String(index + 1).padStart(2, "0")}</span><span className={`risk-level risk-level--${finding.severity}`}>{finding.severity}</span><span><strong>{finding.title}</strong><small>{finding.body}</small><em>{finding.category} · {stop.eyebrow}</em></span><Icon name="chevron-right" size={16} /></button>)}</div> : <div className="summary-clear"><Icon name="check" size={18} /><div><strong>Nothing in the analyzed evidence currently argues against approval.</strong><span>{reviewUpdate.unchangedStopIds.length} previously reviewed areas are unchanged.</span></div></div>}
      </section>
      <section className="summary-context"><div><span>{isUpdate ? "Update" : "Change"}</span><p>{isUpdate ? "The author replaced the Redis counter operation and added its concurrent regression test." : pullRequest.inferredSummary}</p></div><div><span>Author intent</span><AuthorMarkdown source={pullRequest.statedIntent} /></div></section>
      <section className="begin-card"><div><strong>{activeStops.length} review stops</strong><span>{activeStops.reduce((total, stop) => total + stop.minutes, 0)} min · {isUpdate ? "only code changed since your review" : "full PR backstop"}</span></div><button className="button button--hero" onClick={onBegin} type="button">{isUpdate ? "Review updates" : "Review entire PR"} <Icon name="arrow-right" /></button></section>
    </div>
  );
}

function TourView({ activeEvidence, activeEvidenceId, activeIndex, comments, findingRevision, onAsk, onComment, onEvidence, onFindingComment, onFlag, onNavigate, onSelectLine, onUnderstood, reviewMode, selection, status, stop, totalStops }: { activeEvidence: EvidenceBlock; activeEvidenceId: string | null; activeIndex: number; comments: number; findingRevision?: FindingRevision; onAsk: () => void; onComment: () => void; onEvidence: (id: string) => void; onFindingComment: () => void; onFlag: () => void; onNavigate: (delta: number) => void; onSelectLine: (evidenceId: string, line: number, side: "LEFT" | "RIGHT", extend: boolean) => void; onUnderstood: () => void; reviewMode: ReviewMode; selection: Selection | null; status: StopStatus; stop: TourStop; totalStops: number }) {
  return (
    <div className="page page--tour" key={stop.id}>
      <header className="stop-header"><div className="stop-header__topline"><div className="eyebrow">{activeIndex + 1}/{totalStops} · {reviewMode === "update" ? "changed since review" : stop.eyebrow}</div></div><h1>{stop.title}</h1><p>{stop.summary}</p><div className="stop-actions"><button className={`button button--quiet ${status === "flagged" ? "is-flagged" : ""}`} onClick={onFlag} type="button"><Icon name="flag" size={15} />{status === "flagged" ? "Flagged" : "Flag"}</button><button className="button button--quiet" onClick={onAsk} type="button"><Icon name="spark" size={15} />Ask</button><button className="button button--secondary" onClick={onComment} type="button"><Icon name="comment" size={15} />Comment</button>{comments > 0 && <span className="draft-count">{comments} draft</span>}</div></header>
      <div className="tour-grid">
        <section className="evidence-column"><div className="section-label"><span>Code change</span><button type="button"><Icon name="external" size={13} /> {reviewMode === "update" ? `${reviewUpdate.fromHeadSha} → ${reviewUpdate.toHeadSha}` : pullRequest.headSha}</button></div>{stop.evidence.length > 1 && <div className="evidence-tabs">{stop.evidence.map((item) => <button className={item.id === activeEvidenceId ? "is-active" : ""} key={item.id} onClick={() => onEvidence(item.id)} type="button">{item.label}<span>{fileName(item.path)}</span></button>)}</div>}<CodeDiff evidence={activeEvidence} onAsk={onAsk} onComment={onComment} onSelectLine={onSelectLine} selection={selection} /></section>
        <aside className="insight-column">
          <section className="insight-section finding-section">
            <div className="section-label"><span>{findingRevision ? "Earlier finding" : "Review finding"}</span></div>
            {stop.finding ? <article className={`finding-card finding-card--${stop.finding.severity}`}><header><span className={`risk-level risk-level--${stop.finding.severity}`}>{stop.finding.severity}</span><span>{stop.finding.category}</span></header><h3>{stop.finding.title}</h3><p>{stop.finding.body}</p><button className="button button--finding" onClick={onFindingComment} type="button"><Icon name="comment" size={14} /> Draft from finding</button></article> : findingRevision ? <article className="finding-clear finding-clear--resolved"><span><Icon name="check" size={17} /></span><div><small>Appears addressed</small><h3>{findingRevision.title}</h3><p>{findingRevision.summary}</p></div></article> : <article className="finding-clear"><span><Icon name="check" size={17} /></span><div><h3>No blocking finding here</h3><p>Nothing in this stop currently argues against approval.</p></div></article>}
          </section>
          <section className="insight-section"><div className="section-label"><span>Observations</span></div><div className="observation-list">{stop.claims.map((claim) => <article className={`observation observation--${claim.kind}`} key={claim.id}><header><span>{claimKindLabel(claim.kind)}</span><small>{claim.confidence} confidence</small></header><p>{claim.text}</p><button type="button"><Icon name="code" size={13} /> {claim.evidenceIds.length} code anchor{claim.evidenceIds.length === 1 ? "" : "s"}</button></article>)}</div></section>
          <section className="insight-section review-prompts"><div className="section-label"><span>Questions to verify</span></div>{stop.prompts.map((prompt, index) => <button key={prompt} onClick={onAsk} type="button"><span>{String(index + 1).padStart(2, "0")}</span>{prompt}<Icon name="chevron-right" size={14} /></button>)}</section>
        </aside>
      </div>
      <footer className="stop-footer"><button aria-label="Previous stop" className="button button--quiet" disabled={activeIndex === 0} onClick={() => onNavigate(-1)} type="button"><Icon name="arrow-left" size={16} /> Previous</button><span>{status === "understood" ? "Marked understood" : status === "flagged" ? "Flagged for review" : "Ready for your judgment"}</span><button className="button button--complete" onClick={onUnderstood} type="button"><Icon name="check" size={16} />{activeIndex === totalStops - 1 ? "Mark understood & finish" : "Mark understood"}<Icon name="arrow-right" size={16} /></button></footer>
    </div>
  );
}

function BrowseView({ onAsk, onReturn, onSelectStop }: { onAsk: (index: number) => void; onReturn: () => void; onSelectStop: (index: number) => void }) {
  const groups = useMemo(() => tourStops.flatMap((stop, stopIndex) => stop.evidence.map((evidence) => ({ evidence, stop, stopIndex }))), []);
  return <div className="page page--browse"><header className="browse-header"><div><div className="eyebrow">Browse mode</div><h1>The complete evidence set</h1><p>Inspect changes in file order without losing the semantic route.</p></div><button className="button button--secondary" onClick={onReturn} type="button"><Icon name="route" size={16} /> Return to tour <kbd>D</kbd></button></header><div className="browse-layout"><aside className="file-index"><div className="section-label"><span>Changed files</span><b>{pullRequest.filesChanged}</b></div>{groups.map(({ evidence, stopIndex }) => <button key={evidence.id} onClick={() => onSelectStop(stopIndex)} type="button"><Icon name="code" size={14} /><span>{fileName(evidence.path)}<small>{directoryName(evidence.path)}</small></span><Icon name="chevron-right" size={13} /></button>)}<div className="file-index__muted">+ 3 mechanical files grouped</div></aside><div className="browse-diffs">{groups.map(({ evidence, stop, stopIndex }) => <div className="browse-file" key={evidence.id}><div className="browse-file__context"><span>Tour stop {stopIndex + 1}</span><button onClick={() => onSelectStop(stopIndex)} type="button">{stop.title}<Icon name="arrow-right" size={13} /></button></div><CodeDiff evidence={evidence} minimal /><button className="browse-file__ask" onClick={() => onAsk(stopIndex)} type="button"><Icon name="spark" size={14} /> Ask about this change</button></div>)}</div></div></div>;
}

function ReviewDesk({ comments, disposition, onBack, onDisposition, onPublish, onRemoveComment, onSummary, statuses, summary, understood }: { comments: DraftComment[]; disposition: ReviewDisposition; onBack: () => void; onDisposition: (value: ReviewDisposition) => void; onPublish: () => void; onRemoveComment: (id: string) => void; onSummary: (value: string) => void; statuses: Record<string, StopStatus>; summary: string; understood: number }) {
  const flagged = Object.values(statuses).filter((status) => status === "flagged").length;
  return <div className="page page--review"><header className="review-header"><button className="back-link" onClick={onBack} type="button"><Icon name="arrow-left" size={15} /> Back to tour</button><div className="eyebrow">Review desk</div><h1>Turn your understanding into a decision.</h1><p>Everything below is local until you publish. Preview the exact review GitHub will receive.</p></header><div className="review-summary-strip"><div><span className="summary-icon summary-icon--green"><Icon name="check" /></span><span><strong>{understood}/{tourStops.length}</strong><small>stops understood</small></span></div><div><span className="summary-icon summary-icon--amber"><Icon name="flag" /></span><span><strong>{flagged}</strong><small>open flag{flagged === 1 ? "" : "s"}</small></span></div><div><span className="summary-icon summary-icon--blue"><Icon name="comment" /></span><span><strong>{comments.length}</strong><small>draft comment{comments.length === 1 ? "" : "s"}</small></span></div><div className="review-sha"><span className="live-dot" /><span><strong>Head is current</strong><small>{pullRequest.headSha} · checked just now</small></span></div></div><div className="review-grid"><div className="review-main"><section className="review-section"><header><div><span>01</span><div><h2>Review summary</h2><p>Set the context before inline feedback.</p></div></div><small>{summary.length} characters</small></header><textarea onChange={(event) => onSummary(event.target.value)} rows={6} value={summary} /></section><section className="review-section"><header><div><span>02</span><div><h2>Inline comments</h2><p>Anchors are pinned to {pullRequest.headSha}.</p></div></div><small>{comments.length} draft{comments.length === 1 ? "" : "s"}</small></header>{comments.length === 0 ? <div className="empty-comments"><Icon name="comment" /><strong>No inline comments yet</strong><span>You can still publish a summary-only review.</span></div> : <div className="review-comments">{comments.map((comment) => <article key={comment.id}><header><span className={`risk-level risk-level--${comment.severity}`}>{comment.severity}</span><code>{comment.path}:{comment.startLine}{comment.endLine !== comment.startLine ? `–${comment.endLine}` : ""}</code><button aria-label="Remove draft comment" onClick={() => onRemoveComment(comment.id)} type="button"><Icon name="x" size={15} /></button></header><p>{comment.body}</p></article>)}</div>}</section></div><aside className="publish-card"><div className="eyebrow">Final disposition</div><h2>How should GitHub record this review?</h2><div className="disposition-list">{(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as ReviewDisposition[]).map((value) => <button className={disposition === value ? "is-active" : ""} key={value} onClick={() => onDisposition(value)} type="button"><span className="radio"><i /></span><span><strong>{labelDisposition(value)}</strong><small>{dispositionDescription(value)}</small></span></button>)}</div><div className="publish-preview"><span>Will publish</span><strong>{comments.length} inline comment{comments.length === 1 ? "" : "s"}</strong><strong>1 review summary</strong><small>as @alex-rivera</small></div><button className="button button--publish" onClick={onPublish} type="button">Publish review to GitHub <Icon name="external" size={16} /></button><p className="publish-note"><Icon name="shield" size={13} /> This prototype simulates submission. No network request will be made.</p></aside></div></div>;
}

function InvestigationDrawer({ answering, entries, evidence, headSha, modelName, onAsk, onClose, onQuestion, onUseAnswer, providerConfigured, question, stop }: { answering: boolean; entries: NotebookEntry[]; evidence: EvidenceBlock; headSha: string; modelName: string; onAsk: (prompt?: string) => void; onClose: () => void; onQuestion: (value: string) => void; onUseAnswer: (entry: NotebookEntry) => void; providerConfigured: boolean; question: string; stop: TourStop }) {
  return <>
    <button aria-label="Close investigation" className="drawer-backdrop" onClick={onClose} type="button" />
    <aside aria-label="Investigation notebook" className="investigation-drawer">
      <header>
        <div><span className="card-icon card-icon--spark"><Icon name="spark" size={17} /></span><div><div className="eyebrow">Investigation notebook</div><strong>{stop.eyebrow}</strong></div></div>
        <div className="drawer-header-actions"><span className={`drawer-model ${providerConfigured ? "is-live" : ""}`}><i />{providerConfigured ? modelName : "Fixture answers"}</span><button aria-label="Close investigation" className="icon-button" onClick={onClose} type="button"><Icon name="x" size={17} /></button></div>
      </header>
      <div className="drawer-context"><span>Attached evidence</span><div><Icon name="code" size={14} /><span><strong>{fileName(evidence.path)}</strong><small>lines {evidence.startLine}–{evidence.endLine} · {headSha.slice(0, 12)}</small></span><Icon name="check" size={13} /></div></div>
      <div className="drawer-thread">
        {entries.length === 0 && <div className="drawer-intro"><h2>Ask about this change</h2><div className="suggested-questions">{stop.prompts.map((prompt) => <button key={prompt} onClick={() => onAsk(prompt)} type="button">{prompt}<Icon name="arrow-right" size={13} /></button>)}</div></div>}
        {entries.map((entry) => <div className="thread-entry" key={entry.id}><div className="thread-question"><span>You</span><p>{entry.question}</p></div><div className={`thread-answer ${entry.status === "error" ? "is-error" : ""}`}><header><span className="card-icon card-icon--spark"><Icon name="spark" size={14} /></span><strong>{entry.model ?? "Guided fixture"}</strong><small><i className="confidence-dot" /> {entry.provider === "fixture" || !entry.provider ? "Fixture response" : "Grounded in current evidence"}</small></header>{entry.answer ? <p>{entry.answer}</p> : <div className="inline-thinking"><i /><i /><i /></div>}<button disabled={entry.status !== "complete" || !entry.answer.trim()} onClick={() => onUseAnswer(entry)} type="button"><Icon name="comment" size={13} /> Use as comment</button></div></div>)}
        {answering && entries.every((entry) => entry.status !== "streaming") && <div className="thinking"><i /><i /><i /><span>Tracing the evidence…</span></div>}
      </div>
      <form className="drawer-input" onSubmit={(event) => { event.preventDefault(); onAsk(); }}><textarea aria-label="Ask about this change" onChange={(event) => onQuestion(event.target.value)} placeholder="Ask about behavior, failure modes, or context…" rows={3} value={question} /><div><span><kbd>↵</kbd> to ask · {providerConfigured ? `using ${modelName}` : "fixture mode"}</span><button aria-label="Ask question" disabled={!question.trim() || answering} type="submit"><Icon name="arrow-right" size={17} /></button></div></form>
    </aside>
  </>;
}

function ContextPreview({ error, exclusions, manifest, modelName, onCancel, onConfirm, onExclusions, provider, saving }: {
  error: string | null;
  exclusions: string;
  manifest: SessionContextManifest;
  modelName: string;
  onCancel: () => void;
  onConfirm: () => void;
  onExclusions: (value: string) => void;
  provider: ProviderDefinition;
  saving: boolean;
}) {
  return <div className="modal-backdrop context-backdrop" role="presentation"><section aria-label="Model context preview" aria-modal="true" className="context-modal" role="dialog">
    <header><div><div className="eyebrow">Model context</div><h2>Review what leaves this process.</h2></div><button aria-label="Close context preview" className="icon-button" onClick={onCancel} type="button"><Icon name="x" size={17} /></button></header>
    <div className="context-transport"><span className="card-icon card-icon--spark"><Icon name={provider.transport === "cli" ? "code" : "external"} size={16} /></span><div><strong>{provider.name} · {modelName}</strong><span>{provider.transport === "cli" ? "Local CLI transport using your signed-in account" : "Direct API transport using a local environment key"}</span></div><code>{manifest.characters.toLocaleString()} chars</code></div>
    {error && <div className="target-error acquired-generation-error" role="alert"><Icon name="flag" size={13} />{error}</div>}
    {manifest.warnings.length > 0 && <div className="context-warnings">{manifest.warnings.map((warning) => <p key={warning}><Icon name="flag" size={13} />{warning}</p>)}</div>}
    <div className="context-grid">
      <section><div className="section-label"><span>Changed files</span><small>{manifest.includedFiles} sent · {manifest.excludedFiles} excluded</small></div><div className="context-files">{manifest.files.map((file) => <div className={file.included ? "" : "is-excluded"} key={file.path}><Icon name={file.included ? "check" : "x"} size={13} /><span><strong>{file.path}</strong><small>+{file.additions} −{file.deletions}{file.matchedPattern ? ` · ${file.matchedPattern}` : ""}</small></span><span className="context-tags">{file.classifications.map((classification) => <i className={`is-${classification}`} key={classification}>{classification}</i>)}</span></div>)}</div></section>
      <section><div className="section-label"><span>Local exclusions</span><small>one glob per line</small></div><textarea aria-label="Model context exclusions" onChange={(event) => onExclusions(event.target.value)} rows={7} spellCheck={false} value={exclusions} /><div className="context-instructions"><strong>Repository instructions</strong>{manifest.instructions.length ? manifest.instructions.map((instruction) => <span key={instruction.path}><Icon name="code" size={12} />{instruction.path}{instruction.truncated ? " · truncated" : ""}</span>) : <span>None found</span>}</div></section>
    </div>
    <details className="context-prompt"><summary>Exact context preview <span>{manifest.fingerprint.slice(0, 12)}</span></summary><pre>{manifest.promptPreview}</pre></details>
    <footer><span><Icon name="shield" size={13} /> Exclusions are saved locally and invalidate prior tours.</span><div><button className="button button--quiet" onClick={onCancel} type="button">Cancel</button><button className="button button--primary" disabled={saving} onClick={onConfirm} type="button">{saving ? "Preparing…" : "Generate with this context"}<Icon name="arrow-right" size={15} /></button></div></footer>
  </section></div>;
}

function ModelPicker({ onClose, onSelection, providers, selection }: { onClose: () => void; onSelection: (selection: ModelSelection) => void; providers: ProviderDefinition[]; selection: ModelSelection }) {
  const provider = providers.find((candidate) => candidate.id === selection.provider) ?? providers[0]!;
  const active = provider.models.find((model) => model.id === selection.model) ?? provider.models[0]!;

  function chooseProvider(next: ProviderDefinition) {
    const first = next.models[0]!;
    onSelection({ provider: next.id, model: first.id, reasoningEffort: first.defaultEffort });
  }

  return <div className="modal-backdrop model-backdrop" role="presentation"><section aria-modal="true" className="model-modal" role="dialog">
    <header><div><div className="eyebrow">AI provider</div><h2>Choose your review copilot.</h2><p>Codex CLI uses your existing local sign-in. Direct API providers remain optional, and credentials never enter browser JavaScript.</p></div><button aria-label="Close model picker" className="icon-button" onClick={onClose} type="button"><Icon name="x" size={17} /></button></header>
    <div className="provider-tabs">{providers.map((candidate) => <button className={candidate.id === provider.id ? "is-active" : ""} key={candidate.id} onClick={() => chooseProvider(candidate)} type="button"><span>{candidate.name}</span><small className={candidate.configured ? "is-configured" : ""}><i />{candidate.configured ? "Ready" : candidate.transport === "cli" ? "Needs sign-in" : "Needs key"}</small></button>)}</div>
    <div className="model-grid">{provider.models.map((model) => <button className={model.id === active.id ? "is-active" : ""} key={model.id} onClick={() => onSelection({ provider: provider.id, model: model.id, reasoningEffort: model.defaultEffort })} type="button"><span className="model-radio"><i /></span><span><strong>{model.name}{model.badge && <em>{model.badge}</em>}</strong><small>{model.description}</small></span></button>)}</div>
    <section className="reasoning-setting"><div><span>Reasoning effort</span><small>Higher effort can improve difficult reviews with more latency and token usage.</small></div><div>{active.reasoningEfforts.map((effort) => <button className={selection.reasoningEffort === effort ? "is-active" : ""} key={effort} onClick={() => onSelection({ ...selection, reasoningEffort: effort })} type="button">{effort}</button>)}</div></section>
    {!provider.configured && <div className="provider-setup"><Icon name="shield" size={16} /><div><strong>{provider.name} is not ready</strong><p>{provider.setupDescription} Run <code>{provider.setupCommand}</code>, then restart Wingdiff.</p></div></div>}
    <footer><span><Icon name="check" size={13} /> Selection saved locally</span><button className="button button--primary" onClick={onClose} type="button">Use {active.name}</button></footer>
  </section></div>;
}

function CommentComposer({ composer, headSha = pullRequest.headSha, onCancel, onChange, onSeverity, onStage }: { composer: ComposerState; headSha?: string; onCancel: () => void; onChange: (value: string) => void; onSeverity: (value: RiskLevel) => void; onStage: () => void }) {
  const commentSelection: Selection = {
    evidenceId: composer.evidence.id,
    side: composer.side,
    start: composer.startLine,
    end: composer.endLine,
  };

  return <div className="modal-backdrop comment-backdrop" role="presentation"><section aria-modal="true" className="comment-modal" role="dialog">
    <header><div><div className="eyebrow">Draft review comment</div><h2>{fileName(composer.evidence.path)}:{composer.startLine}{composer.endLine !== composer.startLine ? `–${composer.endLine}` : ""}</h2></div><button aria-label="Close comment composer" className="icon-button" onClick={onCancel} type="button"><Icon name="x" size={17} /></button></header>
    <div className="comment-workbench">
      <section className="comment-code"><div className="section-label"><span>Code context</span><small>Selected lines stay highlighted</small></div><CodeDiff evidence={composer.evidence} minimal selection={commentSelection} /></section>
      <section className="comment-editor"><div className="comment-anchor"><Icon name="code" size={14} /><span>{composer.evidence.path}:{composer.startLine}{composer.endLine !== composer.startLine ? `–${composer.endLine}` : ""}{composer.side ? ` · ${composer.side.toLowerCase()}` : ""}</span><code>{headSha}</code></div><label htmlFor="review-comment">Comment</label><textarea autoFocus id="review-comment" onChange={(event) => onChange(event.target.value)} placeholder="What should the author know?" rows={9} value={composer.body} /><div className="comment-severity"><span>Severity</span>{(["low", "medium", "high"] as RiskLevel[]).map((level) => <button className={composer.severity === level ? "is-active" : ""} key={level} onClick={() => onSeverity(level)} type="button"><i className={`severity-dot severity-dot--${level}`} />{level}</button>)}</div><footer><button className="button button--quiet" onClick={onCancel} type="button">Cancel</button><button className="button button--primary" disabled={!composer.body.trim()} onClick={onStage} type="button">Add to review <Icon name="arrow-right" size={15} /></button></footer></section>
    </div>
  </section></div>;
}

function updateNotebookEntry(
  setEntries: React.Dispatch<React.SetStateAction<NotebookEntry[]>>,
  id: string,
  patch: Partial<NotebookEntry>,
) {
  setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
}

function preferredAvailableSelection(providers: ProviderDefinition[], current: ModelSelection): ModelSelection {
  const currentProvider = providers.find((provider) => provider.id === current.provider);
  if (currentProvider?.configured && currentProvider.models.some((model) => model.id === current.model)) return current;
  const provider = providers.find((candidate) => candidate.configured);
  const model = provider?.models[0];
  return provider && model ? { provider: provider.id, model: model.id, reasoningEffort: model.defaultEffort } : current;
}

function checkoutMessage(preparation: TargetPreparation): string {
  const checkout = preparation.environment.checkout;
  if (checkout.status === "matched") return "Current checkout matches";
  if (checkout.status === "different" && checkout.repository) return `Current checkout is ${checkout.repository}`;
  return "No local checkout resolved";
}

function AuthorMarkdown({ fallback, source }: { fallback?: string; source: string }) {
  return <Suspense fallback={<p className="markdown-loading">Formatting description…</p>}><MarkdownContent fallback={fallback} source={source} /></Suspense>;
}

function usePersistentState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => { try { const stored = window.localStorage.getItem(key); return stored ? JSON.parse(stored) as T : fallback; } catch { return fallback; } });
  useEffect(() => { try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage can be unavailable */ } }, [key, value]);
  return [value, setValue] as const;
}

function shortTitle(title: string) { return title.replace(/^The /, "").replace(/^Every /, "").replace(/^Delay /, ""); }
function fileName(path: string) { return path.split("/").at(-1) ?? path; }
function directoryName(path: string) { const pieces = path.split("/"); pieces.pop(); return pieces.length ? `${pieces.join("/")}/` : ""; }
function commentAnchor(evidence: EvidenceBlock, selection: Selection | null) {
  if (selection?.side) {
    const startLine = Math.min(selection.start, selection.end);
    const endLine = Math.max(selection.start, selection.end);
    const line = evidence.lines.find((candidate) => (
      selection.side === "RIGHT" ? candidate.newLine : candidate.oldLine
    ) === endLine);
    if (line?.fingerprint) return { side: selection.side, startLine, endLine, fingerprint: line.fingerprint };
  }
  const line = evidence.lines.find((candidate) => candidate.emphasized && candidate.fingerprint && candidate.newLine !== undefined)
    ?? evidence.lines.find((candidate) => candidate.kind === "addition" && candidate.fingerprint)
    ?? evidence.lines.find((candidate) => candidate.kind === "context" && candidate.fingerprint)
    ?? evidence.lines.find((candidate) => candidate.kind === "deletion" && candidate.fingerprint);
  if (!line?.fingerprint) return null;
  const side = line.kind === "deletion" ? "LEFT" as const : "RIGHT" as const;
  const lineNumber = side === "RIGHT" ? line.newLine : line.oldLine;
  return lineNumber === undefined ? null : { side, startLine: lineNumber, endLine: lineNumber, fingerprint: line.fingerprint };
}
function continuityLabel(state: GeneratedSessionTour["tour"]["findingRevisions"][number]["state"]) {
  if (state === "still-applies") return "still applies";
  if (state === "appears-addressed") return "appears addressed";
  return state;
}
function labelDisposition(value: ReviewDisposition) { if (value === "REQUEST_CHANGES") return "Request changes"; if (value === "APPROVE") return "Approve"; return "Comment"; }
function dispositionDescription(value: ReviewDisposition) { if (value === "REQUEST_CHANGES") return "Block merge until feedback is addressed"; if (value === "APPROVE") return "Signal that this is ready to merge"; return "Share feedback without an approval decision"; }
