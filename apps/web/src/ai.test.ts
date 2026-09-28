import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTION, FALLBACK_PROVIDERS, selectedModel } from "./ai";

describe("AI model selection", () => {
  it("defaults to the balanced OpenAI coding model", () => {
    expect(DEFAULT_SELECTION).toEqual({ provider: "openai", model: "gpt-6-sol", reasoningEffort: "medium" });
    expect(selectedModel(FALLBACK_PROVIDERS, DEFAULT_SELECTION).badge).toBe("Recommended");
  });

  it("keeps Codex and Claude available in the same catalog", () => {
    const ids = FALLBACK_PROVIDERS.flatMap((provider) => provider.models.map((model) => model.id));
    expect(ids).toContain("gpt-5.3-codex");
    expect(ids).toContain("claude-sonnet-4-6");
  });
});

