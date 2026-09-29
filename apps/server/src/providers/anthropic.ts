import Anthropic from "@anthropic-ai/sdk";
import { buildInvestigationPrompt, INVESTIGATION_INSTRUCTIONS } from "./prompt.js";
import { buildTourRequestPrompt, parseStructuredJson, TOUR_INSTRUCTIONS } from "./tourPrompt.js";
import type { TourGenerationInput } from "../tour.js";
import type { InvestigationContext, ModelSelection, TextProvider } from "./types.js";

export class AnthropicProvider implements TextProvider {
  readonly id = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generateTour(
    selection: ModelSelection,
    input: TourGenerationInput,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.client.messages.create({
      model: selection.model,
      max_tokens: 6_000,
      system: TOUR_INSTRUCTIONS,
      messages: [{ role: "user", content: buildTourRequestPrompt(input) }],
    }, { signal });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return parseStructuredJson(text);
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
