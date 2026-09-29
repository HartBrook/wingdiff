export type View = "brief" | "tour" | "browse" | "review";
export type StopStatus = "unseen" | "understood" | "flagged" | "skipped";
export type Confidence = "high" | "medium" | "low";
export type ClaimKind = "fact" | "inference" | "unknown";
export type RiskLevel = "low" | "medium" | "high";
export type DiffLineKind = "context" | "addition" | "deletion" | "header";
export type ReviewDisposition = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export type ReviewMode = "update" | "full";
export type CoverageState = "reviewed-current" | "reviewed-unchanged" | "changed" | "unseen";
export type FindingRevisionState = "new" | "still-applies" | "recheck" | "appears-addressed" | "superseded" | "resolved";
export type ProviderId = "codex" | "openai" | "anthropic";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type AnswerStatus = "streaming" | "complete" | "error";

export interface PullRequestFixture {
  number: number;
  repository: string;
  title: string;
  author: string;
  authorInitials: string;
  branch: string;
  base: string;
  headSha: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  commits: number;
  checks: { passed: number; total: number };
  statedIntent: string;
  inferredSummary: string;
  estimatedMinutes: number;
}

export interface Risk {
  id: string;
  label: string;
  level: RiskLevel;
  detail: string;
  stopId?: string;
}

export interface DiffLine {
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  content: string;
  emphasized?: boolean;
  fingerprint?: string;
}

export interface EvidenceBlock {
  id: string;
  path: string;
  label: string;
  language: string;
  startLine: number;
  endLine: number;
  lines: DiffLine[];
}

export interface Claim {
  id: string;
  text: string;
  kind: ClaimKind;
  confidence: Confidence;
  evidenceIds: string[];
}

export interface Finding {
  id: string;
  title: string;
  body: string;
  severity: RiskLevel;
  category: string;
  evidenceId: string;
  suggestedComment: string;
}

export interface TourStop {
  id: string;
  order: number;
  eyebrow: string;
  title: string;
  summary: string;
  why: string;
  confidence: Confidence;
  minutes: number;
  evidence: EvidenceBlock[];
  claims: Claim[];
  prompts: string[];
  topologyNodes: string[];
  finding?: Finding;
}

export interface TopologyNode {
  id: string;
  label: string;
  detail: string;
  kind: "entry" | "logic" | "boundary" | "contract" | "test";
  x: number;
  y: number;
}

export interface TopologyEdge {
  from: string;
  to: string;
  label?: string;
}

export interface DraftComment {
  id: string;
  stopId: string;
  evidenceId: string;
  path: string;
  side?: "LEFT" | "RIGHT";
  startLine: number;
  endLine: number;
  body: string;
  severity: RiskLevel;
  fingerprint?: string;
}

export interface NotebookEntry {
  id: string;
  stopId: string;
  question: string;
  answer: string;
  createdAt: number;
  provider: ProviderId | "fixture";
  model: string;
  status: AnswerStatus;
}

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

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  configured: boolean;
  transport: "cli" | "api";
  setupCommand: string;
  setupDescription: string;
  models: ModelDefinition[];
}

export interface ModelSelection {
  provider: ProviderId;
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface FindingRevision {
  findingId: string;
  stopId: string;
  title: string;
  severity: RiskLevel;
  state: FindingRevisionState;
  summary: string;
}

export interface ReviewUpdateFixture {
  fromHeadSha: string;
  toHeadSha: string;
  commits: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  changedStopIds: string[];
  unchangedStopIds: string[];
  findingRevisions: FindingRevision[];
}
