import type { ModelSelection, TextProvider } from "./providers/types.js";
import type { ReviewSession, SessionStore, StoredTour, TourScope } from "./sessions.js";
import {
  buildTourGenerationInput,
  validateGeneratedTour,
  type PriorTourFinding,
  type TourEvidenceAnchor,
} from "./tour.js";

export interface SessionTour extends StoredTour {
  anchors: TourEvidenceAnchor[];
}

export async function generateSessionTour(
  session: ReviewSession,
  selection: ModelSelection,
  provider: TextProvider,
  store: SessionStore,
  scope: TourScope = "full",
  signal?: AbortSignal,
): Promise<SessionTour> {
  if (provider.id !== selection.provider) throw new Error("The selected model does not match the configured provider.");
  const evidence = evidenceForScope(session, store, scope);
  const input = buildTourGenerationInput(session.metadata, evidence, priorFindingsForScope(session, store, scope));
  const raw = await provider.generateTour(selection, input, signal);
  const tour = validateGeneratedTour(raw, input);
  const stored = store.saveTour(session.id, scope, selection, evidence.baseSha, evidence.headSha, tour);
  return { ...stored, anchors: input.anchors };
}

export function getSessionTour(session: ReviewSession, store: SessionStore, scope: TourScope = "full"): SessionTour | undefined {
  const evidence = evidenceForScope(session, store, scope);
  const priorFindings = priorFindingsForScope(session, store, scope);
  const stored = store.getTour(session.id, scope);
  if (!stored || stored.baseSha !== evidence.baseSha || stored.headSha !== evidence.headSha) return undefined;
  if (scope === "update") {
    const classified = new Set(stored.tour.findingRevisions.map((revision) => revision.findingId));
    if (classified.size !== priorFindings.length || priorFindings.some((finding) => !classified.has(finding.id))) return undefined;
  }
  const input = buildTourGenerationInput(session.metadata, evidence, priorFindings);
  return { ...stored, anchors: input.anchors };
}

function evidenceForScope(session: ReviewSession, store: SessionStore, scope: TourScope) {
  if (scope === "full") return session.evidence;
  const update = store.getReviewUpdate(session.id);
  if (!update) throw new Error("This session does not have evidence for an update review.");
  return update.evidence;
}

function priorFindingsForScope(session: ReviewSession, store: SessionStore, scope: TourScope): PriorTourFinding[] {
  if (scope !== "update") return [];
  const update = store.getReviewUpdate(session.id);
  if (!update) return [];
  const checkpoint = store.latestCheckpoint(update.baselineSessionId);
  if (!checkpoint) throw new Error("The update baseline does not have a completed review checkpoint.");
  return checkpoint.findingRevisions
    .filter((finding) => finding.state !== "resolved" && finding.state !== "superseded")
    .map((finding) => ({
      id: finding.findingId,
      title: finding.title,
      severity: finding.severity,
      summary: finding.summary,
      pathHints: finding.pathHints ?? [],
    }));
}
