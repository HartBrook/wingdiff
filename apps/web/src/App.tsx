import { useEffect, useMemo, useState } from "react";
import { mockAnswers, pullRequest, reviewUpdate, tourStops, updateStops } from "./fixture";
import {
  DEFAULT_SELECTION,
  FALLBACK_PROVIDERS,
  fetchProviders,
  selectedModel,
  streamInvestigation,
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
import { addRecentTarget, normalizePullRequestTarget, parseLaunchRoute, type PullRequestTarget } from "./launcher";
import { claimKindLabel, compareSeverity } from "./reviewPresentation";

interface Selection {
  evidenceId: string;
  start: number;
  end: number;
}

interface ComposerState {
  stop: TourStop;
  evidence: EvidenceBlock;
  startLine: number;
  endLine: number;
  body: string;
  severity: RiskLevel;
}

const initialStatuses = Object.fromEntries(
  tourStops.map((stop) => [stop.id, "unseen"]),
) as Record<string, StopStatus>;

const rankedFindings = tourStops
  .flatMap((stop, stopIndex) => stop.finding ? [{ finding: stop.finding, stop, stopIndex }] : [])
  .sort((left, right) => compareSeverity(left.finding.severity, right.finding.severity));

export default function App() {
  const route = useMemo(() => parseLaunchRoute(window.location.search), []);
  const [demoOpen, setDemoOpen] = useState(route.demo);

  if (demoOpen) return <ReviewApp />;
  return <Launcher initialTarget={route.target} onDemo={() => {
    window.history.pushState({}, "", "?demo=1");
    setDemoOpen(true);
  }} />;
}

function Launcher({ initialTarget, onDemo }: { initialTarget?: string; onDemo: () => void }) {
  const [input, setInput] = useState(initialTarget ?? "");
  const [target, setTarget] = useState<PullRequestTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
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
    setTarget(null);
    try {
      const normalized = await normalizePullRequestTarget(candidate, signal);
      setTarget(normalized);
      setRecent((current) => addRecentTarget(current, normalized));
      window.history.replaceState({}, "", `?target=${encodeURIComponent(normalized.canonicalUrl)}`);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Wingdiff could not read that pull request target.");
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="launcher-shell">
    <header className="launcher-topbar">
      <div className="brand"><span className="brand__mark"><Icon name="route" size={19} /></span><span>wingdiff</span></div>
      <span className="launcher-local"><i /> Running locally</span>
      <button aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`} className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} type="button"><Icon name={theme === "dark" ? "sun" : "moon"} size={17} /></button>
    </header>
    <main className="launcher-main">
      <section className="launcher-intro">
        <div className="eyebrow">Start a review</div>
        <h1>Paste a pull request.</h1>
        <p>Wingdiff opens it locally and guides you through what changed.</p>
        <form className={`target-form ${error ? "is-error" : ""}`} onSubmit={(event) => { event.preventDefault(); void submitTarget(); }}>
          <Icon name="git-pull" size={19} />
          <input autoFocus aria-label="GitHub pull request" onChange={(event) => setInput(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" spellCheck={false} value={input} />
          <button disabled={!input.trim() || submitting} type="submit">{submitting ? "Checking…" : "Continue"}<Icon name="arrow-right" size={16} /></button>
        </form>
        {error && <div className="target-error" role="alert"><Icon name="flag" size={14} />{error}</div>}
        <div className="target-help"><span>Also accepts</span><code>owner/repo#123</code><span>or run</span><code>wingdiff 123</code><span>inside a checkout</span></div>
      </section>

      {target ? <section className="target-ready">
        <span className="target-ready__icon"><Icon name="check" size={19} /></span>
        <div><div className="eyebrow">Target ready</div><h2>{target.label}</h2><p>Wingdiff recognized this pull request. Live GitHub acquisition is not connected yet, so no repository data was fetched.</p></div>
        <button className="button button--primary" onClick={onDemo} type="button">Preview with demo data <Icon name="arrow-right" size={15} /></button>
      </section> : recent.length > 0 ? <section className="recent-targets">
        <header><span>Recent pull requests</span><small>Stored on this device</small></header>
        {recent.map((item) => <button key={item.canonicalUrl} onClick={() => void submitTarget(item.canonicalUrl)} type="button"><span><strong>{item.label}</strong><small>{item.canonicalUrl}</small></span><Icon name="chevron-right" size={15} /></button>)}
      </section> : <button className="demo-link" onClick={onDemo} type="button"><span><Icon name="spark" size={15} /> Explore the fixture review</span><Icon name="arrow-right" size={14} /></button>}
    </main>
    <footer className="launcher-footer"><span><Icon name="shield" size={13} /> Local server · no Wingdiff account</span><code>127.0.0.1</code></footer>
  </div>;
}

function ReviewApp() {
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

  function selectLine(evidenceId: string, line: number, extend: boolean) {
    setSelection((current) => {
      if (!extend || !current || current.evidenceId !== evidenceId) {
        return { evidenceId, start: line, end: line };
      }
      return { ...current, end: line };
    });
  }

  function openComment(useFinding = false) {
    const selectedEvidence = activeStop.evidence.find((item) => item.id === selection?.evidenceId);
    const findingEvidence = activeStop.evidence.find((item) => item.id === activeStop.finding?.evidenceId);
    const evidence = selectedEvidence ?? (useFinding ? findingEvidence : activeEvidence) ?? activeEvidence;
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
      body: useFinding ? activeStop.finding?.suggestedComment ?? "" : "",
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

        <main className="main-canvas">
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
          modelName={activeModelLabel}
          onAsk={askQuestion}
          onClose={() => setDrawerOpen(false)}
          onQuestion={setQuestion}
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

function TopBar({ activeModel, comments, onMenu, onModel, onReview, onTheme, providerConfigured, theme }: { activeModel: string; comments: number; onMenu: () => void; onModel: () => void; onReview: () => void; onTheme: () => void; providerConfigured: boolean; theme: "dark" | "light" }) {
  return (
    <header className="topbar">
      <button aria-label="Open navigation" className="icon-button mobile-menu" onClick={onMenu} type="button"><Icon name="menu" /></button>
      <div className="brand"><span className="brand__mark"><Icon name="route" size={19} /></span><span>wingdiff</span></div>
      <div className="topbar__divider" />
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
      <section className="summary-context"><div><span>{isUpdate ? "Update" : "Change"}</span><p>{isUpdate ? "The author replaced the Redis counter operation and added its concurrent regression test." : pullRequest.inferredSummary}</p></div><div><span>Author intent</span><p>{pullRequest.statedIntent}</p></div></section>
      <section className="begin-card"><div><strong>{activeStops.length} review stops</strong><span>{activeStops.reduce((total, stop) => total + stop.minutes, 0)} min · {isUpdate ? "only code changed since your review" : "full PR backstop"}</span></div><button className="button button--hero" onClick={onBegin} type="button">{isUpdate ? "Review updates" : "Review entire PR"} <Icon name="arrow-right" /></button></section>
    </div>
  );
}

function TourView({ activeEvidence, activeEvidenceId, activeIndex, comments, findingRevision, onAsk, onComment, onEvidence, onFindingComment, onFlag, onNavigate, onSelectLine, onUnderstood, reviewMode, selection, status, stop, totalStops }: { activeEvidence: EvidenceBlock; activeEvidenceId: string | null; activeIndex: number; comments: number; findingRevision?: FindingRevision; onAsk: () => void; onComment: () => void; onEvidence: (id: string) => void; onFindingComment: () => void; onFlag: () => void; onNavigate: (delta: number) => void; onSelectLine: (evidenceId: string, line: number, extend: boolean) => void; onUnderstood: () => void; reviewMode: ReviewMode; selection: Selection | null; status: StopStatus; stop: TourStop; totalStops: number }) {
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

function InvestigationDrawer({ answering, entries, evidence, modelName, onAsk, onClose, onQuestion, providerConfigured, question, stop }: { answering: boolean; entries: NotebookEntry[]; evidence: EvidenceBlock; modelName: string; onAsk: (prompt?: string) => void; onClose: () => void; onQuestion: (value: string) => void; providerConfigured: boolean; question: string; stop: TourStop }) {
  return <>
    <button aria-label="Close investigation" className="drawer-backdrop" onClick={onClose} type="button" />
    <aside aria-label="Investigation notebook" className="investigation-drawer">
      <header>
        <div><span className="card-icon card-icon--spark"><Icon name="spark" size={17} /></span><div><div className="eyebrow">Investigation notebook</div><strong>{stop.eyebrow}</strong></div></div>
        <div className="drawer-header-actions"><span className={`drawer-model ${providerConfigured ? "is-live" : ""}`}><i />{providerConfigured ? modelName : "Fixture answers"}</span><button aria-label="Close investigation" className="icon-button" onClick={onClose} type="button"><Icon name="x" size={17} /></button></div>
      </header>
      <div className="drawer-context"><span>Attached evidence</span><div><Icon name="code" size={14} /><span><strong>{fileName(evidence.path)}</strong><small>lines {evidence.startLine}–{evidence.endLine} · {pullRequest.headSha}</small></span><Icon name="check" size={13} /></div></div>
      <div className="drawer-thread">
        {entries.length === 0 && <div className="drawer-intro"><h2>Ask about this change</h2><div className="suggested-questions">{stop.prompts.map((prompt) => <button key={prompt} onClick={() => onAsk(prompt)} type="button">{prompt}<Icon name="arrow-right" size={13} /></button>)}</div></div>}
        {entries.map((entry) => <div className="thread-entry" key={entry.id}><div className="thread-question"><span>You</span><p>{entry.question}</p></div><div className={`thread-answer ${entry.status === "error" ? "is-error" : ""}`}><header><span className="card-icon card-icon--spark"><Icon name="spark" size={14} /></span><strong>{entry.model ?? "Guided fixture"}</strong><small><i className="confidence-dot" /> {entry.provider === "fixture" || !entry.provider ? "Fixture response" : "Grounded in current evidence"}</small></header>{entry.answer ? <p>{entry.answer}</p> : <div className="inline-thinking"><i /><i /><i /></div>}<button disabled={entry.status === "streaming"} type="button"><Icon name="comment" size={13} /> Use as comment</button></div></div>)}
        {answering && entries.every((entry) => entry.status !== "streaming") && <div className="thinking"><i /><i /><i /><span>Tracing the evidence…</span></div>}
      </div>
      <form className="drawer-input" onSubmit={(event) => { event.preventDefault(); onAsk(); }}><textarea aria-label="Ask about this change" onChange={(event) => onQuestion(event.target.value)} placeholder="Ask about behavior, failure modes, or context…" rows={3} value={question} /><div><span><kbd>↵</kbd> to ask · {providerConfigured ? `using ${modelName}` : "fixture mode"}</span><button aria-label="Ask question" disabled={!question.trim() || answering} type="submit"><Icon name="arrow-right" size={17} /></button></div></form>
    </aside>
  </>;
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

function CommentComposer({ composer, onCancel, onChange, onSeverity, onStage }: { composer: ComposerState; onCancel: () => void; onChange: (value: string) => void; onSeverity: (value: RiskLevel) => void; onStage: () => void }) {
  const commentSelection: Selection = {
    evidenceId: composer.evidence.id,
    start: composer.startLine,
    end: composer.endLine,
  };

  return <div className="modal-backdrop comment-backdrop" role="presentation"><section aria-modal="true" className="comment-modal" role="dialog">
    <header><div><div className="eyebrow">Draft review comment</div><h2>{fileName(composer.evidence.path)}:{composer.startLine}{composer.endLine !== composer.startLine ? `–${composer.endLine}` : ""}</h2></div><button aria-label="Close comment composer" className="icon-button" onClick={onCancel} type="button"><Icon name="x" size={17} /></button></header>
    <div className="comment-workbench">
      <section className="comment-code"><div className="section-label"><span>Code context</span><small>Selected lines stay highlighted</small></div><CodeDiff evidence={composer.evidence} minimal selection={commentSelection} /></section>
      <section className="comment-editor"><div className="comment-anchor"><Icon name="code" size={14} /><span>{composer.evidence.path}</span><code>{pullRequest.headSha}</code></div><label htmlFor="review-comment">Comment</label><textarea autoFocus id="review-comment" onChange={(event) => onChange(event.target.value)} placeholder="What should the author know?" rows={9} value={composer.body} /><div className="comment-severity"><span>Severity</span>{(["low", "medium", "high"] as RiskLevel[]).map((level) => <button className={composer.severity === level ? "is-active" : ""} key={level} onClick={() => onSeverity(level)} type="button"><i className={`severity-dot severity-dot--${level}`} />{level}</button>)}</div><footer><button className="button button--quiet" onClick={onCancel} type="button">Cancel</button><button className="button button--primary" disabled={!composer.body.trim()} onClick={onStage} type="button">Add to review <Icon name="arrow-right" size={15} /></button></footer></section>
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

function usePersistentState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => { try { const stored = window.localStorage.getItem(key); return stored ? JSON.parse(stored) as T : fallback; } catch { return fallback; } });
  useEffect(() => { try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage can be unavailable */ } }, [key, value]);
  return [value, setValue] as const;
}

function shortTitle(title: string) { return title.replace(/^The /, "").replace(/^Every /, "").replace(/^Delay /, ""); }
function fileName(path: string) { return path.split("/").at(-1) ?? path; }
function directoryName(path: string) { const pieces = path.split("/"); pieces.pop(); return pieces.length ? `${pieces.join("/")}/` : ""; }
function labelDisposition(value: ReviewDisposition) { if (value === "REQUEST_CHANGES") return "Request changes"; if (value === "APPROVE") return "Approve"; return "Comment"; }
function dispositionDescription(value: ReviewDisposition) { if (value === "REQUEST_CHANGES") return "Block merge until feedback is addressed"; if (value === "APPROVE") return "Signal that this is ready to merge"; return "Share feedback without an approval decision"; }
