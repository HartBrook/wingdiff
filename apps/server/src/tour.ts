import { createHash } from "node:crypto";
import type { PullRequestEvidence, ChangedFileEvidence, EvidenceLineKind } from "./diff.js";
import type { PullRequestMetadata } from "./github.js";

export type TourClaimKind = "fact" | "inference" | "unknown";
export type TourConfidence = "high" | "medium" | "low";
export type TourSeverity = "high" | "medium" | "low";

export interface TourEvidenceAnchor {
  id: string;
  path: string;
  kind: "file" | EvidenceLineKind;
  content?: string;
  oldLine?: number;
  newLine?: number;
}

export interface TourGenerationInput {
  pullRequest: {
    repository: string;
    number: number;
    title: string;
    body: string;
    author: string;
    baseRef: string;
    headRef: string;
    baseSha: string;
    headSha: string;
  };
  anchors: TourEvidenceAnchor[];
  fileAnchorIds: string[];
}

export interface GeneratedTourClaim {
  text: string;
  kind: TourClaimKind;
  confidence: TourConfidence;
  anchorIds: string[];
}

export interface GeneratedTourFinding {
  title: string;
  body: string;
  severity: TourSeverity;
  category: string;
  anchorIds: string[];
  suggestedComment: string;
}

export interface GeneratedTourStop {
  id: string;
  title: string;
  summary: string;
  purpose: string;
  anchorIds: string[];
  claims: GeneratedTourClaim[];
  prompts: string[];
  finding?: GeneratedTourFinding;
}

export interface GeneratedTour {
  summary: string;
  stops: GeneratedTourStop[];
}

export function buildTourGenerationInput(metadata: PullRequestMetadata, evidence: PullRequestEvidence): TourGenerationInput {
  const anchors: TourEvidenceAnchor[] = [];
  const fileAnchorIds: string[] = [];

  evidence.files.forEach((file, fileIndex) => {
    const fileId = fileAnchorId(file, fileIndex);
    fileAnchorIds.push(fileId);
    anchors.push({ id: fileId, path: file.path, kind: "file" });
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        anchors.push({
          id: `line_${line.fingerprint}`,
          path: file.path,
          kind: line.kind,
          content: line.content,
          ...(line.oldLine === undefined ? {} : { oldLine: line.oldLine }),
          ...(line.newLine === undefined ? {} : { newLine: line.newLine }),
        });
      }
    }
  });

  return {
    pullRequest: {
      repository: metadata.repository,
      number: metadata.number,
      title: metadata.title,
      body: metadata.body,
      author: metadata.author.login,
      baseRef: metadata.base.ref,
      headRef: metadata.head.ref,
      baseSha: metadata.base.sha,
      headSha: metadata.head.sha,
    },
    anchors,
    fileAnchorIds,
  };
}

export function validateGeneratedTour(raw: unknown, input: TourGenerationInput): GeneratedTour {
  const value = record(raw, "tour");
  const summary = boundedText(value.summary, "tour summary", 500);
  const rawStops = list(value.stops, "tour stops", 1, 12);
  const knownAnchors = new Set(input.anchors.map((anchor) => anchor.id));
  const anchorToPath = new Map(input.anchors.map((anchor) => [anchor.id, anchor.path]));
  const fileAnchorToPath = new Map(input.fileAnchorIds.map((id) => [id, anchorToPath.get(id)!]));
  const ids = new Set<string>();
  const coveredPaths = new Set<string>();

  const stops = rawStops.map((candidate, index): GeneratedTourStop => {
    const stop = record(candidate, `tour stop ${index + 1}`);
    const id = boundedText(stop.id, `tour stop ${index + 1} id`, 64);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Tour stop id must be a lowercase slug: ${id}`);
    if (ids.has(id)) throw new Error(`Tour stop id is duplicated: ${id}`);
    ids.add(id);

    const anchorIds = anchors(stop.anchorIds, `${id} anchors`, knownAnchors, 1, 24);
    anchorIds.forEach((anchorId) => coveredPaths.add(anchorToPath.get(anchorId)!));
    const claims = list(stop.claims, `${id} claims`, 1, 6).map((claimValue, claimIndex): GeneratedTourClaim => {
      const claim = record(claimValue, `${id} claim ${claimIndex + 1}`);
      return {
        text: boundedText(claim.text, `${id} claim text`, 280),
        kind: choice(claim.kind, `${id} claim kind`, ["fact", "inference", "unknown"] as const),
        confidence: choice(claim.confidence, `${id} claim confidence`, ["high", "medium", "low"] as const),
        anchorIds: anchors(claim.anchorIds, `${id} claim anchors`, knownAnchors, 1, 8),
      };
    });
    const prompts = list(stop.prompts, `${id} prompts`, 0, 4)
      .map((prompt, promptIndex) => boundedText(prompt, `${id} prompt ${promptIndex + 1}`, 220));
    const finding = stop.finding === undefined || stop.finding === null
      ? undefined
      : validateFinding(stop.finding, id, knownAnchors);

    return {
      id,
      title: boundedText(stop.title, `${id} title`, 140),
      summary: boundedText(stop.summary, `${id} summary`, 360),
      purpose: boundedText(stop.purpose, `${id} purpose`, 280),
      anchorIds,
      claims,
      prompts,
      ...(finding ? { finding } : {}),
    };
  });

  for (const [fileAnchorId, path] of fileAnchorToPath) {
    if (!coveredPaths.has(path)) throw new Error(`Generated tour does not cover changed file ${path} (${fileAnchorId}).`);
  }

  return { summary, stops };
}

export function buildTourPrompt(input: TourGenerationInput): string {
  const grouped = new Map<string, TourEvidenceAnchor[]>();
  for (const anchor of input.anchors) {
    const current = grouped.get(anchor.path) ?? [];
    current.push(anchor);
    grouped.set(anchor.path, current);
  }

  const evidence = [...grouped.entries()].map(([path, anchors]) => {
    const lines = anchors.map((anchor) => {
      if (anchor.kind === "file") return `FILE_ANCHOR ${anchor.id}`;
      const location = anchor.newLine === undefined ? `old:${anchor.oldLine}` : `new:${anchor.newLine}`;
      const marker = anchor.kind === "addition" ? "+" : anchor.kind === "deletion" ? "-" : " ";
      return `${anchor.id}\t${location}\t${marker}${anchor.content ?? ""}`;
    });
    return `FILE ${path}\n${lines.join("\n")}`;
  }).join("\n\n");

  return `<pull_request>
REPOSITORY: ${input.pullRequest.repository}
NUMBER: ${input.pullRequest.number}
TITLE: ${input.pullRequest.title}
AUTHOR: ${input.pullRequest.author}
BASE: ${input.pullRequest.baseRef} ${input.pullRequest.baseSha}
HEAD: ${input.pullRequest.headRef} ${input.pullRequest.headSha}
DESCRIPTION:
${input.pullRequest.body || "(none)"}
</pull_request>

<validated_evidence>
${evidence}
</validated_evidence>`;
}

function validateFinding(raw: unknown, stopId: string, knownAnchors: Set<string>): GeneratedTourFinding {
  const finding = record(raw, `${stopId} finding`);
  return {
    title: boundedText(finding.title, `${stopId} finding title`, 160),
    body: boundedText(finding.body, `${stopId} finding body`, 420),
    severity: choice(finding.severity, `${stopId} finding severity`, ["high", "medium", "low"] as const),
    category: boundedText(finding.category, `${stopId} finding category`, 80),
    anchorIds: anchors(finding.anchorIds, `${stopId} finding anchors`, knownAnchors, 1, 8),
    suggestedComment: boundedText(finding.suggestedComment, `${stopId} suggested comment`, 500),
  };
}

function fileAnchorId(file: ChangedFileEvidence, index: number): string {
  const digest = createHash("sha256").update(`${file.path}\0${file.status}`).digest("hex").slice(0, 12);
  return `file_${String(index + 1).padStart(3, "0")}_${digest}`;
}

function anchors(value: unknown, label: string, known: Set<string>, minimum: number, maximum: number): string[] {
  const values = list(value, label, minimum, maximum).map((anchor, index) => boundedText(anchor, `${label} ${index + 1}`, 80));
  for (const anchor of values) {
    if (!known.has(anchor)) throw new Error(`${label} references unknown evidence anchor ${anchor}.`);
  }
  return [...new Set(values)];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function list(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum}–${maximum} items.`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters.`);
  return text;
}

function choice<const T extends readonly string[]>(value: unknown, label: string, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new Error(`${label} must be one of: ${choices.join(", ")}.`);
  return value as T[number];
}
