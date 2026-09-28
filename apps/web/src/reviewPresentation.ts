import type { ClaimKind, RiskLevel } from "./types";

const severityWeight: Record<RiskLevel, number> = { high: 3, medium: 2, low: 1 };

export function compareSeverity(left: RiskLevel, right: RiskLevel): number {
  return severityWeight[right] - severityWeight[left];
}

export function claimKindLabel(kind: ClaimKind): string {
  if (kind === "fact") return "Verified behavior";
  if (kind === "inference") return "Engineering read";
  return "Open question";
}
