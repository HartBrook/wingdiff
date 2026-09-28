import { describe, expect, it } from "vitest";
import { claimKindLabel, compareSeverity } from "./reviewPresentation";

describe("review presentation", () => {
  it("orders findings from highest to lowest review importance", () => {
    expect(([...(["low", "high", "medium"] as const)]).sort(compareSeverity)).toEqual(["high", "medium", "low"]);
  });

  it("uses reviewer-native labels instead of model taxonomy", () => {
    expect(claimKindLabel("fact")).toBe("Verified behavior");
    expect(claimKindLabel("inference")).toBe("Engineering read");
    expect(claimKindLabel("unknown")).toBe("Open question");
  });
});
