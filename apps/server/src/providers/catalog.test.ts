import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, publicProviders, validateSelection } from "./catalog.js";

describe("model catalog", () => {
  it("offers OpenAI, Codex, and Anthropic choices", () => {
    expect(MODEL_CATALOG.map((model) => model.id)).toEqual([
      "gpt-6-sol",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-5.3-codex",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
    ]);
  });

  it("defaults GPT-6 Sol to medium reasoning", () => {
    const model = MODEL_CATALOG.find((candidate) => candidate.id === "gpt-6-sol");
    expect(model?.defaultEffort).toBe("medium");
    expect(model?.badge).toBe("Recommended");
  });

  it("never exposes API keys in public provider metadata", () => {
    const providers = publicProviders({ OPENAI_API_KEY: "secret-openai" });
    expect(providers.find((provider) => provider.id === "openai")?.configured).toBe(true);
    expect(providers.find((provider) => provider.id === "anthropic")?.configured).toBe(false);
    expect(JSON.stringify(providers)).not.toContain("secret-openai");
  });

  it("rejects cross-provider and unsupported reasoning selections", () => {
    expect(() => validateSelection({ provider: "anthropic", model: "gpt-6-sol", reasoningEffort: "medium" })).toThrow(/does not belong/);
    expect(() => validateSelection({ provider: "openai", model: "gpt-6-astra", reasoningEffort: "none" })).toThrow(/does not support/);
  });
});

