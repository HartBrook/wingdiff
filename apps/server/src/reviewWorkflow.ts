import type { ReviewSession, SessionStore, TourScope, FindingCheckpoint, ReviewProgressStatus } from "./sessions.js";
import { getSessionTour } from "./tourService.js";

const COVERED_STATUSES = new Set<ReviewProgressStatus>(["understood", "flagged", "skipped"]);

export function validateCurrentTourStop(
  session: ReviewSession,
  store: SessionStore,
  scope: TourScope,
  stopId: string,
) {
  const tour = getSessionTour(session, store, scope);
  if (!tour) throw new Error(`Generate the ${scope === "update" ? "update" : "full PR"} guided review first.`);
  if (!tour.tour.stops.some((stop) => stop.id === stopId)) {
    throw new Error(`Review stop is not part of the current ${scope} tour: ${stopId}`);
  }
  return tour;
}

export function checkpointCoverageForSession(
  session: ReviewSession,
  store: SessionStore,
  scope: TourScope,
  coverage: Record<string, string>,
): Record<string, string> {
  const tour = getSessionTour(session, store, scope);
  if (!tour) throw new Error(`Generate the ${scope === "update" ? "update" : "full PR"} guided review first.`);
  const expected = new Set(tour.tour.stops.map((stop) => stop.id));
  const actual = Object.keys(coverage);
  const unknown = actual.find((stopId) => !expected.has(stopId));
  if (unknown) throw new Error(`Review coverage contains a stale or unknown stop: ${unknown}`);
  const missing = [...expected].find((stopId) => !Object.hasOwn(coverage, stopId));
  if (missing) throw new Error(`Review coverage is incomplete at stop: ${missing}`);
  for (const [stopId, status] of Object.entries(coverage)) {
    if (!COVERED_STATUSES.has(status as ReviewProgressStatus)) throw new Error(`Review stop ${stopId} has not been reviewed.`);
  }
  const update = store.getReviewUpdate(session.id);
  const baselineCoverage = scope === "update" && update
    ? store.latestCheckpoint(update.baselineSessionId)?.coverage ?? {}
    : {};
  return {
    ...baselineCoverage,
    ...Object.fromEntries(Object.entries(coverage).map(([stopId, status]) => [`${scope}-${stopId}`, status])),
  };
}

export function checkpointFindingsForSession(
  session: ReviewSession,
  store: SessionStore,
  scope: TourScope,
): FindingCheckpoint[] {
  const generated = getSessionTour(session, store, scope);
  if (!generated) throw new Error(`Generate the ${scope === "update" ? "update" : "full PR"} guided review first.`);
  const update = store.getReviewUpdate(session.id);
  const baseline = update ? store.latestCheckpoint(update.baselineSessionId) : undefined;
  const previous = new Map((baseline?.findingRevisions ?? []).map((finding) => [finding.findingId, finding]));
  const anchors = new Map(generated.anchors.map((anchor) => [anchor.id, anchor]));
  const next: FindingCheckpoint[] = [];

  if (scope === "update") {
    for (const revision of generated.tour.findingRevisions) {
      const prior = previous.get(revision.findingId);
      if (!prior) continue;
      const pathHints = pathsFor(revision.anchorIds, anchors);
      next.push({ ...prior, state: revision.state, summary: revision.summary, pathHints: pathHints.length ? pathHints : prior.pathHints });
    }
    for (const prior of previous.values()) {
      if ((prior.state === "resolved" || prior.state === "superseded") && !next.some((finding) => finding.findingId === prior.findingId)) {
        next.push(prior);
      }
    }
  } else {
    next.push(...previous.values());
  }

  for (const stop of generated.tour.stops) {
    if (!stop.finding) continue;
    const findingId = `${stop.id}-finding`;
    if (next.some((finding) => finding.findingId === findingId)) continue;
    next.push({
      findingId,
      title: stop.finding.title,
      severity: stop.finding.severity,
      state: "new",
      summary: stop.finding.body,
      pathHints: pathsFor(stop.finding.anchorIds, anchors),
    });
  }
  return next;
}

export function approvalWarnings(session: ReviewSession, store: SessionStore, scope: TourScope): string[] {
  const warnings: string[] = [];
  const generated = getSessionTour(session, store, scope);
  if (!generated) return ["No current guided review exists for this scope."];
  const statuses = store.getReviewProgress(session.id).scopes[scope];
  const unseen = generated.tour.stops.filter((stop) => !statuses[stop.id] || statuses[stop.id] === "unseen").length;
  const flagged = generated.tour.stops.filter((stop) => statuses[stop.id] === "flagged").length;
  const highFindings = checkpointFindingsForSession(session, store, scope)
    .filter((finding) => finding.severity === "high" && ["new", "still-applies", "recheck"].includes(finding.state)).length;
  if (unseen) warnings.push(`${unseen} review stop${unseen === 1 ? " is" : "s are"} still unseen.`);
  if (flagged) warnings.push(`${flagged} review stop${flagged === 1 ? " remains" : "s remain"} flagged.`);
  if (highFindings) warnings.push(`${highFindings} high-severity finding${highFindings === 1 ? " remains" : "s remain"}.`);
  if (session.metadata.checks.failed) warnings.push(`${session.metadata.checks.failed} required check${session.metadata.checks.failed === 1 ? " is" : "s are"} failing.`);
  return warnings;
}

function pathsFor(anchorIds: string[], anchors: Map<string, { path: string }>) {
  return [...new Set(anchorIds.flatMap((id) => {
    const path = anchors.get(id)?.path;
    return path ? [path] : [];
  }))];
}
