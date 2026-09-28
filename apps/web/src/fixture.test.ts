import { describe, expect, it } from "vitest";
import { risks, topologyNodes, tourStops } from "./fixture";

describe("guided review fixture", () => {
  it("has a stable, contiguous route", () => {
    expect(tourStops).toHaveLength(5);
    expect(tourStops.map((stop) => stop.order)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(tourStops.map((stop) => stop.id)).size).toBe(tourStops.length);
  });

  it("grounds every claim in evidence owned by its stop", () => {
    for (const stop of tourStops) {
      const evidenceIds = new Set(stop.evidence.map((evidence) => evidence.id));

      expect(stop.claims.length, `${stop.id} should contain claims`).toBeGreaterThan(0);
      for (const claim of stop.claims) {
        expect(claim.evidenceIds.length, `${claim.id} should contain anchors`).toBeGreaterThan(0);
        for (const evidenceId of claim.evidenceIds) {
          expect(evidenceIds.has(evidenceId), `${claim.id} references ${evidenceId}`).toBe(true);
        }
      }
    }
  });

  it("keeps evidence ranges and displayed lines internally consistent", () => {
    for (const stop of tourStops) {
      for (const evidence of stop.evidence) {
        expect(evidence.startLine).toBeLessThanOrEqual(evidence.endLine);

        const displayedLines = evidence.lines
          .flatMap((line) => [line.oldLine, line.newLine])
          .filter((line): line is number => line !== undefined);

        expect(displayedLines.length, `${evidence.id} should display numbered lines`).toBeGreaterThan(0);
        expect(Math.min(...displayedLines)).toBeGreaterThanOrEqual(evidence.startLine);
        expect(Math.max(...displayedLines)).toBeLessThanOrEqual(evidence.endLine);
      }
    }
  });

  it("references only known topology nodes and tour stops", () => {
    const nodeIds = new Set(topologyNodes.map((node) => node.id));
    const stopIds = new Set(tourStops.map((stop) => stop.id));

    for (const stop of tourStops) {
      for (const nodeId of stop.topologyNodes) {
        expect(nodeIds.has(nodeId), `${stop.id} references topology node ${nodeId}`).toBe(true);
      }
    }

    for (const risk of risks) {
      expect(risk.stopId, `${risk.id} should link to a stop`).toBeTruthy();
      expect(stopIds.has(risk.stopId!), `${risk.id} references ${risk.stopId}`).toBe(true);
    }
  });

  it("attaches findings to evidence in the same stop", () => {
    for (const stop of tourStops.filter((candidate) => candidate.finding)) {
      expect(stop.evidence.some((evidence) => evidence.id === stop.finding!.evidenceId)).toBe(true);
      expect(stop.finding!.suggestedComment.length).toBeGreaterThan(40);
    }
  });
});

