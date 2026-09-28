export type PullRequestTargetSource = "url" | "shorthand" | "checkout";

export interface PullRequestTarget {
  owner: string;
  repository: string;
  number: number;
  canonicalUrl: string;
  label: string;
  source: PullRequestTargetSource;
}

const REPOSITORY_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)$/;
const SHORTHAND_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)#([1-9]\d*)$/;
const NUMBER_PATTERN = /^#?([1-9]\d*)$/;

export function parsePullRequestTarget(input: unknown, checkoutRepository?: string): PullRequestTarget {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Paste a GitHub pull request URL or enter a pull request number.");
  }

  const value = input.trim();
  const urlTarget = parseGitHubUrl(value);
  if (urlTarget) return target(urlTarget.owner, urlTarget.repository, urlTarget.number, "url");

  const shorthand = SHORTHAND_PATTERN.exec(value);
  if (shorthand) {
    return target(shorthand[1]!, shorthand[2]!, positiveInteger(shorthand[3]!), "shorthand");
  }

  const number = NUMBER_PATTERN.exec(value);
  if (number) {
    const repository = parseRepositoryName(checkoutRepository);
    if (!repository) {
      throw new Error("A pull request number requires a GitHub repository checkout. Paste the full URL instead.");
    }
    return target(repository.owner, repository.repository, positiveInteger(number[1]!), "checkout");
  }

  throw new Error("Use a GitHub pull request URL, owner/repo#123, or a pull request number.");
}

export function repositoryFromRemoteUrl(remote: string | undefined): string | undefined {
  if (!remote?.trim()) return undefined;
  const value = remote.trim().replace(/\/$/, "").replace(/\.git$/, "");

  const scpMatch = /^git@github\.com:([^/]+\/[^/]+)$/i.exec(value);
  if (scpMatch) return normalizeRepository(scpMatch[1]);

  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    return normalizeRepository(url.pathname.replace(/^\//, ""));
  } catch {
    return undefined;
  }
}

function parseGitHubUrl(value: string): { owner: string; repository: string; number: number } | undefined {
  if (!/^https?:\/\//i.test(value)) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("That pull request URL is not valid.");
  }

  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (hostname !== "github.com" && hostname !== "www.github.com")) {
    throw new Error("Wingdiff currently supports HTTPS pull request URLs from github.com.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull") {
    throw new Error("Paste a GitHub pull request URL such as https://github.com/owner/repo/pull/123.");
  }

  const repository = parseRepositoryName(`${parts[0]}/${parts[1]}`);
  if (!repository || !/^[1-9]\d*$/.test(parts[3]!)) {
    throw new Error("That GitHub pull request URL is not valid.");
  }

  return { ...repository, number: positiveInteger(parts[3]!) };
}

function parseRepositoryName(value: string | undefined): { owner: string; repository: string } | undefined {
  if (!value) return undefined;
  const match = REPOSITORY_PATTERN.exec(value.trim().replace(/\.git$/, ""));
  return match ? { owner: match[1]!, repository: match[2]! } : undefined;
}

function normalizeRepository(value: string | undefined): string | undefined {
  const repository = parseRepositoryName(value);
  return repository ? `${repository.owner}/${repository.repository}` : undefined;
}

function positiveInteger(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("The pull request number is not valid.");
  return number;
}

function target(owner: string, repository: string, number: number, source: PullRequestTargetSource): PullRequestTarget {
  const canonicalUrl = `https://github.com/${owner}/${repository}/pull/${number}`;
  return {
    owner,
    repository,
    number,
    canonicalUrl,
    label: `${owner}/${repository}#${number}`,
    source,
  };
}
