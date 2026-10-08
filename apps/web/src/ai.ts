import type {
  ModelDefinition,
  ModelSelection,
  ProviderDefinition,
  ReasoningEffort,
  TourStop,
} from "./types";

export const DEFAULT_SELECTION: ModelSelection = {
  provider: "codex",
  model: "codex-default",
  reasoningEffort: "medium",
};

const OPENAI_MODELS: ModelDefinition[] = [
  model("gpt-6-sol", "GPT-6 Sol", "OpenAI", "Balanced reasoning, latency, and cost for everyday code review.", "API", ["none", "low", "medium", "high", "xhigh", "max"], "medium"),
  model("gpt-6-astra", "GPT-6 Astra", "OpenAI", "Highest capability for architectural and high-risk reviews.", "Deep review", ["low", "medium", "high", "xhigh", "max"], "high"),
  model("gpt-6-luna", "GPT-6 Luna", "OpenAI", "Fast, cost-efficient investigation for routine questions.", "Fast", ["none", "low", "medium", "high", "xhigh", "max"], "low"),
  model("gpt-5.3-codex", "GPT-5.3-Codex", "OpenAI API", "Deprecated Codex model available through direct API authentication only.", "Deprecated", ["low", "medium", "high", "xhigh"], "medium"),
];

export const FALLBACK_PROVIDERS: ProviderDefinition[] = [
  {
    id: "codex",
    name: "Codex CLI",
    configured: false,
    transport: "cli",
    setupCommand: "codex login",
    setupDescription: "Install Codex CLI and sign in with your ChatGPT account.",
    models: [
      model("codex-default", "Account default", "Codex", "Let Codex choose the default model supported by your signed-in account.", "Recommended", ["low", "medium", "high"], "medium", "codex"),
    ],
  },
  {
    id: "openai",
    name: "OpenAI API",
    configured: false,
    transport: "api",
    setupCommand: "OPENAI_API_KEY",
    setupDescription: "Set an OpenAI API key in your shell or local .env file.",
    models: OPENAI_MODELS,
  },
  {
    id: "anthropic",
    name: "Anthropic API",
    configured: false,
    transport: "api",
    setupCommand: "ANTHROPIC_API_KEY",
    setupDescription: "Set an Anthropic API key in your shell or local .env file.",
    models: [
      model("claude-sonnet-4-6", "Claude Sonnet 4.6", "Anthropic", "Fast, capable analysis for interactive review.", "Balanced", ["medium"], "medium", "anthropic"),
      model("claude-opus-4-6", "Claude Opus 4.6", "Anthropic", "Deeper analysis for complex changes.", "Deep review", ["high"], "high", "anthropic"),
    ],
  },
];

export async function fetchProviders(signal?: AbortSignal): Promise<ProviderDefinition[]> {
  const response = await fetch("/api/providers", { signal });
  if (!response.ok) throw new Error("Could not load AI providers.");
  const body = await response.json() as { providers: ProviderDefinition[] };
  return body.providers;
}

export async function streamInvestigation({
  selection,
  stop,
  question,
  onDelta,
  signal,
}: {
  selection: ModelSelection;
  stop: TourStop;
  question: string;
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
}) {
  return streamInvestigationRequest("/api/investigate", {
    selection,
    context: {
      question,
      stop: {
        title: stop.title,
        summary: stop.summary,
        why: stop.why,
        claims: stop.claims.map(({ text, kind, confidence }) => ({ text, kind, confidence })),
        evidence: stop.evidence.map(({ path, startLine, endLine, lines }) => ({ path, startLine, endLine, lines })),
      },
    },
  }, onDelta, signal);
}

export async function streamSessionInvestigation({
  sessionId,
  scope,
  selection,
  stopId,
  question,
  onDelta,
  signal,
}: {
  sessionId: string;
  scope: "full" | "update";
  selection: ModelSelection;
  stopId: string;
  question: string;
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
}) {
  return streamInvestigationRequest(`/api/sessions/${encodeURIComponent(sessionId)}/investigate`, {
    selection,
    scope,
    stopId,
    question,
  }, onDelta, signal);
}

async function streamInvestigationRequest(
  url: string,
  payload: unknown,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `AI request failed with status ${response.status}.`);
  }
  if (!response.body) throw new Error("AI response did not include a stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const data = event.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (!data) continue;
      const payload = JSON.parse(data) as { type: "delta" | "done" | "error"; delta?: string; error?: string };
      if (payload.type === "delta" && payload.delta) onDelta(payload.delta);
      if (payload.type === "error") throw new Error(payload.error ?? "AI stream failed.");
    }
    if (done) break;
  }
}

export function selectedModel(providers: ProviderDefinition[], selection: ModelSelection) {
  return providers.find((provider) => provider.id === selection.provider)?.models.find((candidate) => candidate.id === selection.model)
    ?? FALLBACK_PROVIDERS.find((provider) => provider.id === selection.provider)?.models.find((candidate) => candidate.id === selection.model)
    ?? FALLBACK_PROVIDERS[0]!.models[0]!;
}

export function normalizeSelection(providers: ProviderDefinition[], current: ModelSelection): ModelSelection {
  const provider = providers.find((candidate) => candidate.id === current?.provider);
  if (!provider) return DEFAULT_SELECTION;
  const model = provider.models.find((candidate) => candidate.id === current.model) ?? provider.models[0];
  if (!model) return current;
  if (model.id === current.model && model.reasoningEfforts.includes(current.reasoningEffort)) return current;
  return { provider: provider.id, model: model.id, reasoningEffort: model.defaultEffort };
}

export function preferredAvailableSelection(providers: ProviderDefinition[], current: ModelSelection): ModelSelection {
  const normalized = normalizeSelection(providers, current);
  if (providers.some((provider) => provider.id === normalized.provider && provider.configured)) return normalized;
  const provider = providers.find((candidate) => candidate.configured);
  const model = provider?.models[0];
  return provider && model ? { provider: provider.id, model: model.id, reasoningEffort: model.defaultEffort } : normalized;
}

function model(
  id: string,
  name: string,
  family: string,
  description: string,
  badge: string,
  reasoningEfforts: ReasoningEffort[],
  defaultEffort: ReasoningEffort,
  provider: ModelDefinition["provider"] = "openai",
): ModelDefinition {
  return { id, provider, name, family, description, badge, reasoningEfforts, defaultEffort };
}
