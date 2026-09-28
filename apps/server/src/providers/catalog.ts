import type {
  ModelDefinition,
  ModelSelection,
  ProviderId,
  PublicProvider,
  ReasoningEffort,
} from "./types.js";

const OPENAI_MODELS: ModelDefinition[] = [
  {
    id: "gpt-6-sol",
    provider: "openai",
    name: "GPT-6 Sol",
    family: "OpenAI",
    description: "Balanced reasoning, latency, and cost for everyday code review.",
    badge: "Recommended",
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
    family: "Codex",
    description: "Codex-tuned model for agentic coding and code investigation.",
    badge: "Codex",
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

export const MODEL_CATALOG: ModelDefinition[] = [...OPENAI_MODELS, ...ANTHROPIC_MODELS];

const PROVIDER_METADATA: Record<ProviderId, { name: string; envVariable: string }> = {
  openai: { name: "OpenAI / Codex", envVariable: "OPENAI_API_KEY" },
  anthropic: { name: "Anthropic", envVariable: "ANTHROPIC_API_KEY" },
};

export function publicProviders(environment: NodeJS.ProcessEnv): PublicProvider[] {
  return (["openai", "anthropic"] as ProviderId[]).map((id) => ({
    id,
    ...PROVIDER_METADATA[id],
    configured: Boolean(environment[PROVIDER_METADATA[id].envVariable]),
    models: MODEL_CATALOG.filter((model) => model.provider === id),
  }));
}

export function validateSelection(input: unknown): ModelSelection {
  if (!input || typeof input !== "object") throw new Error("A model selection is required.");
  const value = input as Record<string, unknown>;
  const model = MODEL_CATALOG.find((candidate) => candidate.id === value.model);
  if (!model) throw new Error(`Unknown model: ${String(value.model)}`);
  if (model.provider !== value.provider) {
    throw new Error(`Model ${model.id} does not belong to provider ${String(value.provider)}.`);
  }
  const effort = value.reasoningEffort as ReasoningEffort;
  if (!model.reasoningEfforts.includes(effort)) {
    throw new Error(`${model.name} does not support ${String(effort)} reasoning.`);
  }
  return { provider: model.provider, model: model.id, reasoningEffort: effort };
}

