export type ProviderId = "openai" | "anthropic";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelDefinition {
  id: string;
  provider: ProviderId;
  name: string;
  family: string;
  description: string;
  badge?: string;
  reasoningEfforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
}

export interface PublicProvider {
  id: ProviderId;
  name: string;
  configured: boolean;
  envVariable: string;
  models: ModelDefinition[];
}

export interface ModelSelection {
  provider: ProviderId;
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface InvestigationContext {
  question: string;
  stop: {
    title: string;
    summary: string;
    why: string;
    claims: Array<{
      text: string;
      kind: "fact" | "inference" | "unknown";
      confidence: "high" | "medium" | "low";
    }>;
    evidence: Array<{
      path: string;
      startLine: number;
      endLine: number;
      lines: Array<{
        kind: string;
        oldLine?: number;
        newLine?: number;
        content: string;
      }>;
    }>;
  };
}

export interface TextProvider {
  readonly id: ProviderId;
  streamInvestigation(
    selection: ModelSelection,
    context: InvestigationContext,
    signal?: AbortSignal,
  ): AsyncIterable<string>;
}

