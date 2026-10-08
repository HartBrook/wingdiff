import type {
  ModelDefinition,
  ModelSelection,
  ProviderId,
  PublicProvider,
  ReasoningEffort,
} from "./types.js";

const CODEX_MODELS: ModelDefinition[] = [
  {
    id: "codex-default",
    provider: "codex",
    name: "Account default",
    family: "Codex",
    description: "Let Codex choose the default model supported by your signed-in account.",
    badge: "Recommended",
    reasoningEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
];

const OPENAI_MODELS: ModelDefinition[] = [
  {
    id: "gpt-6-sol",
    provider: "openai",
    name: "GPT-6 Sol",
    family: "OpenAI",
    description: "Balanced reasoning, latency, and cost for everyday code review.",
    badge: "API",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-6-astra",
    provider: "openai",
    name: "GPT-6 Astra",
    family: "OpenAI",
    description: "Highest capability for architectural and high-risk reviews.",
    badge: "Deep review",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
  },
  {
    id: "gpt-6-luna",
    provider: "openai",
    name: "GPT-6 Luna",
    family: "OpenAI",
    description: "Fast, cost-efficient investigation for routine questions.",
    badge: "Fast",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "low",
  },
  {
    id: "gpt-5.3-codex",
    provider: "openai",
    name: "GPT-5.3-Codex",
    family: "OpenAI API",
    description: "Deprecated Codex model available through direct API authentication only.",
    badge: "Deprecated",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
  },
];

const ANTHROPIC_MODELS: ModelDefinition[] = [
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    name: "Claude Sonnet 4.6",
    family: "Anthropic",
    description: "Fast, capable analysis for interactive review.",
    badge: "Balanced",
    reasoningEfforts: ["medium"],
    defaultEffort: "medium",
  },
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    name: "Claude Opus 4.6",
    family: "Anthropic",
    description: "Deeper analysis for complex changes.",
    badge: "Deep review",
    reasoningEfforts: ["high"],
    defaultEffort: "high",
  },
];

export const MODEL_CATALOG: ModelDefinition[] = [...CODEX_MODELS, ...OPENAI_MODELS, ...ANTHROPIC_MODELS];

const PROVIDER_METADATA: Record<ProviderId, Omit<PublicProvider, "id" | "configured" | "models">> = {
  codex: {
    name: "Codex CLI",
    transport: "cli",
    setupCommand: "codex login",
    setupDescription: "Install Codex CLI and sign in with your ChatGPT account.",
  },
  openai: {
    name: "OpenAI API",
    transport: "api",
    setupCommand: "OPENAI_API_KEY",
    setupDescription: "Set an OpenAI API key in your shell or local .env file.",
  },
  anthropic: {
    name: "Anthropic API",
    transport: "api",
    setupCommand: "ANTHROPIC_API_KEY",
    setupDescription: "Set an Anthropic API key in your shell or local .env file.",
  },
};

export function publicProviders(
  environment: NodeJS.ProcessEnv,
  configuredProviders: ReadonlySet<ProviderId> = new Set(),
): PublicProvider[] {
  return (["codex", "openai", "anthropic"] as ProviderId[]).map((id) => ({
    id,
    ...PROVIDER_METADATA[id],
    configured: id === "codex"
      ? configuredProviders.has(id)
      : Boolean(environment[id === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"]),
    models: MODEL_CATALOG.filter((model) => model.provider === id),
  }));
}

export function validateSelection(input: unknown): ModelSelection {
  if (!input || typeof input !== "object") throw new Error("A model selection is required.");
  const value = input as Record<string, unknown>;
  if (value.provider === "codex" && value.model !== "codex-default") {
    throw new Error("Codex CLI must use your account's default model. Choose Account default, or use the OpenAI API provider for a named model.");
  }
  const model = MODEL_CATALOG.find((candidate) => (
    candidate.id === value.model && candidate.provider === value.provider
  ));
  if (!model) throw new Error(`Unknown model: ${String(value.model)}`);
  const effort = value.reasoningEffort as ReasoningEffort;
  if (!model.reasoningEfforts.includes(effort)) {
    throw new Error(`${model.name} does not support ${String(effort)} reasoning.`);
  }
  return { provider: model.provider, model: model.id, reasoningEffort: effort };
}
