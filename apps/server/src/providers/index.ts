import { AnthropicProvider } from "./anthropic.js";
import { CodexCliProvider, codexCliReady } from "./codex.js";
import { OpenAIProvider } from "./openai.js";
import type { ProviderId, TextProvider } from "./types.js";

export function createProviders(environment: NodeJS.ProcessEnv): Map<ProviderId, TextProvider> {
  const providers = new Map<ProviderId, TextProvider>();
  const codexExecutable = environment.WINGDIFF_CODEX_BIN || "codex";
  if (codexCliReady(codexExecutable, environment)) {
    providers.set("codex", new CodexCliProvider(codexExecutable, environment));
  }
  if (environment.OPENAI_API_KEY) providers.set("openai", new OpenAIProvider(environment.OPENAI_API_KEY));
  if (environment.ANTHROPIC_API_KEY) providers.set("anthropic", new AnthropicProvider(environment.ANTHROPIC_API_KEY));
  return providers;
}

export * from "./catalog.js";
export * from "./prompt.js";
export type * from "./types.js";
