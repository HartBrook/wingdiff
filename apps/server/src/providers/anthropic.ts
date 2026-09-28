import Anthropic from "@anthropic-ai/sdk";
import { buildInvestigationPrompt, INVESTIGATION_INSTRUCTIONS } from "./prompt.js";
import type { InvestigationContext, ModelSelection, TextProvider } from "./types.js";

export class AnthropicProvider implements TextProvider {
  readonly id = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async *streamInvestigation(
    selection: ModelSelection,
    context: InvestigationContext,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    const stream = this.client.messages.stream({
      model: selection.model,
      max_tokens: 800,
      system: INVESTIGATION_INSTRUCTIONS,
      messages: [{ role: "user", content: buildInvestigationPrompt(context) }],
    }, { signal });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }
  }
}
