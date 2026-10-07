import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTION, FALLBACK_PROVIDERS, normalizeSelection, preferredAvailableSelection, selectedModel } from "./ai";
import type { ModelSelection } from "./types";

describe("AI model selection", () => {
  it("lets the local Codex CLI choose the account's supported default", () => {
    expect(DEFAULT_SELECTION).toEqual({ provider: "codex", model: "codex-default", reasoningEffort: "medium" });
    expect(selectedModel(FALLBACK_PROVIDERS, DEFAULT_SELECTION).badge).toBe("Recommended");
  });

  it("keeps CLI, API, and Claude options in the same catalog", () => {
    expect(FALLBACK_PROVIDERS.map((provider) => provider.id)).toEqual(["codex", "openai", "anthropic"]);
    expect(FALLBACK_PROVIDERS.find((provider) => provider.id === "codex")?.models.map((model) => model.id)).toEqual(["codex-default"]);
    expect(FALLBACK_PROVIDERS.find((provider) => provider.id === "openai")?.models.map((model) => model.id)).toContain("gpt-5.3-codex");
    expect(FALLBACK_PROVIDERS.find((provider) => provider.id === "anthropic")?.models.map((model) => model.id)).toContain("claude-sonnet-4-6");
  });

  it("resolves named API models within the selected provider", () => {
    expect(selectedModel(FALLBACK_PROVIDERS, { provider: "openai", model: "gpt-6-sol", reasoningEffort: "medium" }).provider).toBe("openai");
  });

  it("migrates a saved named Codex selection to the account default", () => {
    const providers = FALLBACK_PROVIDERS.map((provider) => ({ ...provider, configured: provider.id === "codex" }));
    expect(preferredAvailableSelection(providers, {
      provider: "codex",
      model: "gpt-6-sol",
      reasoningEffort: "medium",
    })).toEqual(DEFAULT_SELECTION);
  });

  it("migrates a saved named Codex selection even when no provider is configured", () => {
    const saved: ModelSelection = { provider: "codex", model: "gpt-5.3-codex", reasoningEffort: "xhigh" };
    expect(preferredAvailableSelection(FALLBACK_PROVIDERS, saved)).toEqual(DEFAULT_SELECTION);
    expect(normalizeSelection(FALLBACK_PROVIDERS, saved)).toEqual(DEFAULT_SELECTION);
  });

  it("stays on the current provider when its saved model is no longer offered", () => {
    const providers = FALLBACK_PROVIDERS.map((provider) => ({ ...provider, configured: true }));
    expect(preferredAvailableSelection(providers, { provider: "openai", model: "gpt-4-retired", reasoningEffort: "medium" }))
      .toEqual({ provider: "openai", model: "gpt-6-sol", reasoningEffort: "medium" });
  });

  it("resets a reasoning effort the saved model does not support", () => {
    const providers = FALLBACK_PROVIDERS.map((provider) => ({ ...provider, configured: true }));
    expect(preferredAvailableSelection(providers, { provider: "openai", model: "gpt-6-astra", reasoningEffort: "none" }))
      .toEqual({ provider: "openai", model: "gpt-6-astra", reasoningEffort: "high" });
  });

  it("keeps a valid selection untouched and replaces an unreadable one", () => {
    const saved: ModelSelection = { provider: "openai", model: "gpt-6-luna", reasoningEffort: "low" };
    expect(normalizeSelection(FALLBACK_PROVIDERS, saved)).toBe(saved);
    expect(normalizeSelection(FALLBACK_PROVIDERS, null as unknown as ModelSelection)).toEqual(DEFAULT_SELECTION);
  });

  it("moves to a configured provider when the saved one is not set up", () => {
    const providers = FALLBACK_PROVIDERS.map((provider) => ({ ...provider, configured: provider.id === "anthropic" }));
    expect(preferredAvailableSelection(providers, DEFAULT_SELECTION))
      .toEqual({ provider: "anthropic", model: "claude-sonnet-4-6", reasoningEffort: "medium" });
  });
});
