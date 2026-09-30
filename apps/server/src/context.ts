import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ChangedFileEvidence, PullRequestEvidence } from "./diff.js";
import type { ReviewSession, SessionStore, TourScope } from "./sessions.js";
import { buildTourGenerationInput, buildTourPrompt, type PriorTourFinding, type TourGenerationInput } from "./tour.js";

const INSTRUCTION_PATHS = ["AGENTS.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md"];
const MAX_INSTRUCTION_CHARACTERS = 20_000;
const MAX_MODEL_CONTEXT_CHARACTERS = 750_000;
const DEFAULT_EXCLUSIONS = ["**/.env*", "**/*.pem", "**/*.key"];
const execFile = promisify(execFileCallback);

export interface ContextFileManifest {
  path: string;
  included: boolean;
  matchedPattern?: string;
  classifications: Array<"sensitive" | "generated" | "vendor">;
  additions: number;
  deletions: number;
  characters: number;
}

export interface RepositoryInstruction {
  path: string;
  content: string;
  characters: number;
  truncated: boolean;
}

export interface SessionContextManifest {
  scope: TourScope;
  baseSha: string;
  headSha: string;
  excludedPatterns: string[];
  files: ContextFileManifest[];
  instructions: RepositoryInstruction[];
  includedFiles: number;
  excludedFiles: number;
  characters: number;
  warnings: string[];
  ready: boolean;
  promptPreview: string;
  fingerprint: string;
}

export interface SessionGenerationContext {
  evidence: PullRequestEvidence;
  priorFindings: PriorTourFinding[];
  input: TourGenerationInput;
  manifest: SessionContextManifest;
}

export async function buildSessionGenerationContext(
  session: ReviewSession,
  store: SessionStore,
  scope: TourScope,
  repositoryRoot: string,
): Promise<SessionGenerationContext> {
  const sourceEvidence = evidenceForScope(session, store, scope);
  const excludedPatterns = store.getContextExclusions(session.id, DEFAULT_EXCLUSIONS);
  const { evidence, files } = filterEvidence(sourceEvidence, excludedPatterns);
  const instructions = await readRepositoryInstructions(repositoryRoot, session.metadata.head.sha);
  const priorFindings = priorFindingsForSession(session, store, scope);
  const input = buildTourGenerationInput(
    session.metadata,
    evidence,
    priorFindings,
    instructions.map(({ path, content }) => ({ path, content })),
  );
  const promptPreview = buildTourPrompt(input);
  const includedFiles = files.filter((file) => file.included).length;
  const warnings = contextWarnings(files, instructions, promptPreview.length);
  return {
    evidence,
    priorFindings,
    input,
    manifest: {
      scope,
      baseSha: evidence.baseSha,
      headSha: evidence.headSha,
      excludedPatterns,
      files,
      instructions,
      includedFiles,
      excludedFiles: files.length - includedFiles,
      characters: promptPreview.length,
      warnings,
      ready: includedFiles > 0 && promptPreview.length <= MAX_MODEL_CONTEXT_CHARACTERS,
      promptPreview,
      fingerprint: createHash("sha256").update(promptPreview).digest("hex"),
    },
  };
}

export function filteredEvidenceForSession(session: ReviewSession, store: SessionStore, scope: TourScope): PullRequestEvidence {
  return filterEvidence(
    evidenceForScope(session, store, scope),
    store.getContextExclusions(session.id, DEFAULT_EXCLUSIONS),
  ).evidence;
}

function evidenceForScope(session: ReviewSession, store: SessionStore, scope: TourScope): PullRequestEvidence {
  if (scope === "full") return session.evidence;
  const update = store.getReviewUpdate(session.id);
  if (!update) throw new Error("This session does not have evidence for an update review.");
  return update.evidence;
}

export function priorFindingsForSession(session: ReviewSession, store: SessionStore, scope: TourScope): PriorTourFinding[] {
  if (scope !== "update") return [];
  const update = store.getReviewUpdate(session.id);
  if (!update) return [];
  const checkpoint = store.latestCheckpoint(update.baselineSessionId);
  if (!checkpoint) throw new Error("The update baseline does not have a completed review checkpoint.");
  return checkpoint.findingRevisions
    .filter((finding) => finding.state !== "resolved" && finding.state !== "superseded")
    .map((finding) => ({
      id: finding.findingId,
      title: finding.title,
      severity: finding.severity,
      summary: finding.summary,
      pathHints: finding.pathHints ?? [],
    }));
}

function filterEvidence(evidence: PullRequestEvidence, patterns: string[]): { evidence: PullRequestEvidence; files: ContextFileManifest[] } {
  const files = evidence.files.map((file) => {
    const matchedPattern = patterns.find((pattern) => globMatches(file.path, pattern));
    const classifications = classifyFile(file);
    const characters = file.hunks.reduce((total, hunk) => total + hunk.header.length + hunk.lines.reduce((sum, line) => sum + line.content.length, 0), 0);
    return {
      path: file.path,
      included: !matchedPattern,
      ...(matchedPattern ? { matchedPattern } : {}),
      classifications,
      additions: file.additions,
      deletions: file.deletions,
      characters,
    } satisfies ContextFileManifest;
  });
  const includedPaths = new Set(files.filter((file) => file.included).map((file) => file.path));
  const included = evidence.files.filter((file) => includedPaths.has(file.path));
  return {
    files,
    evidence: {
      ...evidence,
      files: included,
      additions: included.reduce((total, file) => total + file.additions, 0),
      deletions: included.reduce((total, file) => total + file.deletions, 0),
    },
  };
}

function classifyFile(file: ChangedFileEvidence): ContextFileManifest["classifications"] {
  const value = `${file.path}\n${file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.content)).join("\n")}`;
  const classifications: ContextFileManifest["classifications"] = [];
  if (/(^|\/)(?:node_modules|vendor|third_party|dist|build)(\/|$)/i.test(file.path)) classifications.push("vendor");
  if (/\.(?:min\.js|map|lock|generated\.[^.]+)$/i.test(file.path)
    || /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.lock|go\.sum)$/i.test(file.path)
    || /(?:@generated|code generated|do not edit)/i.test(value)) classifications.push("generated");
  if (/(^|\/)(?:\.env[^/]*|secrets?|credentials?)(\/|$)|\.(?:pem|key|p12|pfx)$/i.test(file.path)
    || /(?:BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]|client[_-]?secret\s*[:=]|password\s*[:=]|token\s*[:=])/i.test(value)) {
    classifications.push("sensitive");
  }
  return classifications;
}

async function readRepositoryInstructions(repositoryRoot: string, headSha: string): Promise<RepositoryInstruction[]> {
  let root: string;
  try {
    root = await realpath(repositoryRoot);
  } catch {
    return [];
  }
  const instructions: RepositoryInstruction[] = [];
  for (const relativePath of INSTRUCTION_PATHS) {
    try {
      const raw = await readInstructionAtRevision(root, headSha, relativePath);
      if (raw === undefined) continue;
      const content = raw.slice(0, MAX_INSTRUCTION_CHARACTERS);
      instructions.push({ path: relativePath, content, characters: content.length, truncated: raw.length > content.length });
    } catch {
      // Missing, unreadable, or non-text instruction files are omitted.
    }
  }
  return instructions;
}

async function readInstructionAtRevision(
  repositoryRoot: string,
  headSha: string,
  relativePath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("git", ["show", `${headSha}:${relativePath}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: MAX_INSTRUCTION_CHARACTERS * 2,
    });
    return stdout;
  } catch {
    // Legacy sessions and synthetic fixtures may not have their pinned objects locally.
  }

  const candidate = path.resolve(repositoryRoot, relativePath);
  try {
    const resolved = await realpath(candidate);
    if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${path.sep}`)) return undefined;
    return await readFile(resolved, "utf8");
  } catch {
    return undefined;
  }
}

function contextWarnings(files: ContextFileManifest[], instructions: RepositoryInstruction[], characters: number): string[] {
  const warnings: string[] = [];
  const includedSensitive = files.filter((file) => file.included && file.classifications.includes("sensitive"));
  if (includedSensitive.length) warnings.push(`${includedSensitive.length} included file${includedSensitive.length === 1 ? " is" : "s are"} marked potentially sensitive.`);
  const includedGenerated = files.filter((file) => file.included && file.classifications.some((value) => value === "generated" || value === "vendor"));
  if (includedGenerated.length) warnings.push(`${includedGenerated.length} generated or vendor file${includedGenerated.length === 1 ? " is" : "s are"} included.`);
  if (instructions.some((instruction) => instruction.truncated)) warnings.push("A repository instruction file was truncated to 20,000 characters.");
  if (characters > MAX_MODEL_CONTEXT_CHARACTERS) warnings.push("Model context exceeds 750,000 characters. Exclude generated or low-value files before generation.");
  return warnings;
}

function globMatches(value: string, pattern: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(value);
}
