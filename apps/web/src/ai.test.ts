import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTION, FALLBACK_PROVIDERS, selectedModel } from "./ai";

describe("AI model selection", () => {
  it("defaults to the balanced model through the local Codex CLI", () => {
    expect(DEFAULT_SELECTION).toEqual({ provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" });
    expect(selectedModel(FALLBACK_PROVIDERS, DEFAULT_SELECTION).badge).toBe("Recommended");
  });

  it("keeps CLI, API, and Claude options in the same catalog", () => {
    expect(FALLBACK_PROVIDERS.map((provider) => provider.id)).toEqual(["codex", "openai", "anthropic"]);
    expect(FALLBACK_PROVIDERS.find((provider) => provider.id === "codex")?.models.map((model) => model.id)).toContain("gpt-5.3-codex");
    expect(FALLBACK_PROVIDERS.find((provider) => provider.id === "anthropic")?.models.map((model) => model.id)).toContain("claude-sonnet-4-6");
  });

  it("resolves duplicate model ids within the selected provider", () => {
    expect(selectedModel(FALLBACK_PROVIDERS, { ...DEFAULT_SELECTION, provider: "openai" }).provider).toBe("openai");
  });
});
