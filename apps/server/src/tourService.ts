import type { ModelSelection, TextProvider } from "./providers/types.js";
import type { ReviewSession, SessionStore, StoredTour, TourScope } from "./sessions.js";
import { buildSessionGenerationContext, filteredEvidenceForSession, priorFindingsForSession } from "./context.js";
import {
  buildTourGenerationInput,
  validateGeneratedTour,
  type GeneratedTour,
  type TourEvidenceAnchor,
} from "./tour.js";

export interface SessionTour extends Omit<StoredTour, "contextManifest" | "anchors"> {
  anchors: TourEvidenceAnchor[];
}

export async function generateSessionTour(
  session: ReviewSession,
  selection: ModelSelection,
  provider: TextProvider,
  store: SessionStore,
  scope: TourScope = "full",
  signal?: AbortSignal,
  repositoryRoot = process.cwd(),
): Promise<SessionTour> {
  if (provider.id !== selection.provider) throw new Error("The selected model does not match the configured provider.");
  const { evidence, input, manifest } = await buildSessionGenerationContext(session, store, scope, repositoryRoot);
  if (!evidence.files.length) throw new Error("Every changed file is excluded from model context. Keep at least one file to generate a tour.");
  if (!manifest.ready) throw new Error("Model context is too large. Exclude generated or low-value files before generating a tour.");
  const raw = await provider.generateTour(selection, input, signal);
  let tour: GeneratedTour;
  try {
    tour = validateGeneratedTour(raw, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The model returned an invalid guided tour.";
    if (message.includes("references unknown evidence anchor")) {
      throw new Error(`The model returned an invalid evidence reference, so Wingdiff discarded the tour. Retry generation. (${message})`);
    }
    throw error;
  }
  const stored = store.saveTour(session.id, scope, selection, evidence.baseSha, evidence.headSha, tour, {
    manifest,
    anchors: input.anchors,
  });
  const { contextManifest: _contextManifest, anchors: storedAnchors, ...publicStored } = stored;
  return { ...publicStored, anchors: storedAnchors ?? input.anchors };
}

export function getSessionTour(session: ReviewSession, store: SessionStore, scope: TourScope = "full"): SessionTour | undefined {
  const evidence = filteredEvidenceForSession(session, store, scope);
  const priorFindings = priorFindingsForSession(session, store, scope);
  const stored = store.getTour(session.id, scope);
  if (!stored || stored.baseSha !== evidence.baseSha || stored.headSha !== evidence.headSha) return undefined;
  if (scope === "update") {
    const classified = new Set(stored.tour.findingRevisions.map((revision) => revision.findingId));
    if (classified.size !== priorFindings.length || priorFindings.some((finding) => !classified.has(finding.id))) return undefined;
  }
  const anchors = stored.anchors ?? buildTourGenerationInput(session.metadata, evidence, priorFindings).anchors;
  const { contextManifest: _contextManifest, anchors: _storedAnchors, ...publicStored } = stored;
  return { ...publicStored, anchors };
}
