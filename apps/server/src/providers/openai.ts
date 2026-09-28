import OpenAI from "openai";
import { buildInvestigationPrompt, INVESTIGATION_INSTRUCTIONS } from "./prompt.js";
import type { InvestigationContext, ModelSelection, TextProvider } from "./types.js";

export class OpenAIProvider implements TextProvider {
  readonly id = "openai" as const;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async *streamInvestigation(
    selection: ModelSelection,
    context: InvestigationContext,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    const stream = await this.client.responses.create({
      model: selection.model,
      instructions: INVESTIGATION_INSTRUCTIONS,
      input: buildInvestigationPrompt(context),
      reasoning: { effort: selection.reasoningEffort === "none" ? "none" : selection.reasoningEffort },
      text: { verbosity: "low" },
      max_output_tokens: 800,
      store: false,
      stream: true,
    }, { signal });

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") yield event.delta;
      if (event.type === "response.failed") {
        throw new Error(event.response.error?.message ?? "OpenAI response failed.");
      }
      if (event.type === "error") throw new Error(event.message);
    }
  }
}
