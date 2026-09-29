import type { ModelSelection, TextProvider } from "./providers/types.js";
import type { ReviewSession, SessionStore, StoredTour } from "./sessions.js";
import {
  buildTourGenerationInput,
  validateGeneratedTour,
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
  signal?: AbortSignal,
): Promise<SessionTour> {
  if (provider.id !== selection.provider) throw new Error("The selected model does not match the configured provider.");
  const input = buildTourGenerationInput(session.metadata, session.evidence);
  const raw = await provider.generateTour(selection, input, signal);
  const tour = validateGeneratedTour(raw, input);
  const stored = store.saveTour(session.id, selection, session.metadata.head.sha, tour);
  return { ...stored, anchors: input.anchors };
}

export function getSessionTour(session: ReviewSession, store: SessionStore): SessionTour | undefined {
  const stored = store.getTour(session.id);
  if (!stored || stored.headSha !== session.metadata.head.sha) return undefined;
  const input = buildTourGenerationInput(session.metadata, session.evidence);
  return { ...stored, anchors: input.anchors };
}
