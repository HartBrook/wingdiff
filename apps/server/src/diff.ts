import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { GitCommandRunner, PinnedRevisions } from "./git.js";

const execFile = promisify(execFileCallback);

export type ChangedFileStatus = "added" | "deleted" | "modified" | "renamed" | "binary";
export type EvidenceLineKind = "context" | "addition" | "deletion";

export interface EvidenceLine {
  kind: EvidenceLineKind;
  content: string;
  oldLine?: number;
  newLine?: number;
  fingerprint: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: EvidenceLine[];
}

export interface ChangedFileEvidence {
  oldPath?: string;
  path: string;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface PullRequestEvidence {
  baseSha: string;
  headSha: string;
  additions: number;
  deletions: number;
  files: ChangedFileEvidence[];
}

export async function readDiffEvidence(
  revisions: PinnedRevisions,
  runCommand: GitCommandRunner = defaultGitCommandRunner,
): Promise<PullRequestEvidence> {
  const comparisonBase = revisions.comparisonBase ?? revisions.base;
  const output = await runCommand([
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--find-renames",
    "--unified=20",
    comparisonBase.sha,
    revisions.head.sha,
    "--",
  ], revisions.repositoryRoot);
  return parseUnifiedDiff(output, comparisonBase.sha, revisions.head.sha);
}

export function parseUnifiedDiff(input: string, baseSha: string, headSha: string): PullRequestEvidence {
  const files: ChangedFileEvidence[] = [];
  let file: ChangedFileEvidence | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  function finishHunk() {
    if (!hunk) return;
    const consumedOld = hunk.lines.filter((line) => line.kind !== "addition").length;
    const consumedNew = hunk.lines.filter((line) => line.kind !== "deletion").length;
    if (consumedOld !== hunk.oldLines || consumedNew !== hunk.newLines) {
      throw new Error(`Diff hunk line counts do not match ${file?.path ?? "the changed file"}: ${hunk.header}`);
    }
    file!.hunks.push(hunk);
    hunk = undefined;
  }

  function finishFile() {
    finishHunk();
    if (!file) return;
    if (!file.path) throw new Error("A changed file is missing its destination path.");
    if (file.status !== "binary") {
      file.additions = file.hunks.flatMap((item) => item.lines).filter((line) => line.kind === "addition").length;
      file.deletions = file.hunks.flatMap((item) => item.lines).filter((line) => line.kind === "deletion").length;
    }
    files.push(file);
    file = undefined;
  }

  for (const rawLine of input.split(/\r?\n/)) {
    if (rawLine.startsWith("diff --git ")) {
      finishFile();
      const paths = /^diff --git a\/(.+) b\/(.+)$/.exec(rawLine);
      file = {
        ...(paths ? { oldPath: paths[1] } : {}),
        path: paths?.[2] ?? "",
        status: "modified",
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }
    if (!file) continue;

    if (rawLine.startsWith("rename from ")) {
      file.oldPath = rawLine.slice("rename from ".length);
      file.status = "renamed";
      continue;
    }
    if (rawLine.startsWith("rename to ")) {
      file.path = rawLine.slice("rename to ".length);
      file.status = "renamed";
      continue;
    }
    if (rawLine.startsWith("--- ")) {
      const path = diffPath(rawLine.slice(4));
      if (path) file.oldPath = path;
      else {
        file.status = "added";
        delete file.oldPath;
      }
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      const path = diffPath(rawLine.slice(4));
      if (path) file.path = path;
      else {
        file.status = "deleted";
        file.path = file.oldPath ?? "";
      }
      continue;
    }
    if (rawLine.startsWith("Binary files ") || rawLine.startsWith("GIT binary patch")) {
      file.status = "binary";
      if (!file.path) file.path = file.oldPath ?? binaryDestination(rawLine);
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
    if (hunkMatch) {
      finishHunk();
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      hunk = {
        header: rawLine,
        oldStart: oldLine,
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: newLine,
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        lines: [],
      };
      continue;
    }
    if (!hunk || rawLine === "\\ No newline at end of file") continue;

    const marker = rawLine[0];
    const content = rawLine.slice(1);
    if (marker === " ") {
      hunk.lines.push(line("context", content, file.path || file.oldPath || "", oldLine, newLine));
      oldLine += 1;
      newLine += 1;
    } else if (marker === "+") {
      hunk.lines.push(line("addition", content, file.path, undefined, newLine));
      newLine += 1;
    } else if (marker === "-") {
      hunk.lines.push(line("deletion", content, file.oldPath ?? file.path, oldLine, undefined));
      oldLine += 1;
    }
  }
  finishFile();

  return {
    baseSha,
    headSha,
    additions: files.reduce((total, item) => total + item.additions, 0),
    deletions: files.reduce((total, item) => total + item.deletions, 0),
    files,
  };
}

function line(kind: EvidenceLineKind, content: string, path: string, oldLine?: number, newLine?: number): EvidenceLine {
  const identity = `${path}\0${kind}\0${oldLine ?? ""}\0${newLine ?? ""}\0${content}`;
  return {
    kind,
    content,
    ...(oldLine === undefined ? {} : { oldLine }),
    ...(newLine === undefined ? {} : { newLine }),
    fingerprint: createHash("sha256").update(identity).digest("hex").slice(0, 20),
  };
}

function diffPath(value: string): string | undefined {
  const path = value.split("\t", 1)[0]!;
  if (path === "/dev/null") return undefined;
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function binaryDestination(line: string): string {
  const match = /^Binary files (?:a\/)?(.+?) and (?:b\/)?(.+?) differ$/.exec(line);
  return match?.[2] ?? match?.[1] ?? "binary-file";
}

async function defaultGitCommandRunner(arguments_: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile("git", arguments_, { cwd, maxBuffer: 100 * 1024 * 1024 });
  return stdout;
}
