import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, publicProviders, validateSelection } from "./catalog.js";

describe("model catalog", () => {
  it("offers OpenAI, Codex, and Anthropic choices", () => {
    expect(MODEL_CATALOG.map((model) => model.id)).toEqual([
      "codex-default",
      "gpt-6-sol",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-5.3-codex",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
    ]);
  });

  it("lets Codex choose the signed-in account's default model", () => {
    const model = MODEL_CATALOG.find((candidate) => candidate.id === "codex-default");
    expect(model?.defaultEffort).toBe("medium");
    expect(model?.reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(model?.badge).toBe("Recommended");
  });

  it("never exposes API keys in public provider metadata", () => {
    const providers = publicProviders({ OPENAI_API_KEY: "secret-openai" }, new Set(["codex"]));
    expect(providers.find((provider) => provider.id === "codex")?.configured).toBe(true);
    expect(providers.find((provider) => provider.id === "openai")?.configured).toBe(true);
    expect(providers.find((provider) => provider.id === "anthropic")?.configured).toBe(false);
    expect(providers.find((provider) => provider.id === "codex")?.models.map((model) => model.id)).toEqual(["codex-default"]);
    expect(providers.find((provider) => provider.id === "openai")?.models.map((model) => model.id)).toContain("gpt-5.3-codex");
    expect(JSON.stringify(providers)).not.toContain("secret-openai");
  });

  it("rejects cross-provider and unsupported reasoning selections", () => {
    expect(() => validateSelection({ provider: "anthropic", model: "gpt-6-sol", reasoningEffort: "medium" })).toThrow(/Unknown model/);
    expect(() => validateSelection({ provider: "openai", model: "gpt-6-astra", reasoningEffort: "none" })).toThrow(/does not support/);
    expect(() => validateSelection({ provider: "codex", model: "gpt-5.3-codex", reasoningEffort: "medium" })).toThrow(/must use your account's default model/);
    expect(() => validateSelection({ provider: "codex", model: "gpt-6-sol", reasoningEffort: "medium" })).toThrow(/must use your account's default model/);
    expect(validateSelection({ provider: "openai", model: "gpt-5.3-codex", reasoningEffort: "medium" }).provider).toBe("openai");
    expect(validateSelection({ provider: "codex", model: "codex-default", reasoningEffort: "medium" })).toEqual({
      provider: "codex",
      model: "codex-default",
      reasoningEffort: "medium",
    });
  });
});
