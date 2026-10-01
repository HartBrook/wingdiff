import { describe, expect, it } from "vitest";
import { CODEX_SECURITY_OVERRIDES, codexInvestigationTimeoutMs, codexTourTimeoutMs } from "./codex.js";

describe("Codex CLI isolation", () => {
  it("prevents model-invoked tools from inheriting secrets or browsing", () => {
    expect(CODEX_SECURITY_OVERRIDES).toEqual([
      "-c",
      'shell_environment_policy.inherit="none"',
      "-c",
      "tools.web_search=false",
    ]);
  });
});

describe("Codex CLI timeouts", () => {
  it("allows ten minutes for tours and three minutes for investigations by default", () => {
    expect(codexTourTimeoutMs({})).toBe(600_000);
    expect(codexInvestigationTimeoutMs({})).toBe(180_000);
  });

  it("supports request-specific overrides with the legacy shared override as a fallback", () => {
    const shared = { WINGDIFF_CODEX_TIMEOUT_MS: "240000" };
    expect(codexTourTimeoutMs(shared)).toBe(240_000);
    expect(codexInvestigationTimeoutMs(shared)).toBe(240_000);

    const specific = {
      ...shared,
      WINGDIFF_CODEX_TOUR_TIMEOUT_MS: "720000",
      WINGDIFF_CODEX_INVESTIGATION_TIMEOUT_MS: "90000",
    };
    expect(codexTourTimeoutMs(specific)).toBe(720_000);
    expect(codexInvestigationTimeoutMs(specific)).toBe(90_000);
  });

  it("ignores invalid or sub-second overrides", () => {
    expect(codexTourTimeoutMs({ WINGDIFF_CODEX_TOUR_TIMEOUT_MS: "soon" })).toBe(600_000);
    expect(codexInvestigationTimeoutMs({ WINGDIFF_CODEX_INVESTIGATION_TIMEOUT_MS: "999" })).toBe(180_000);
  });
});
