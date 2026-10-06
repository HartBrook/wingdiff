export type PullRequestTargetSource = "url" | "shorthand" | "checkout";
export type CodeHost = "github" | "gitlab";

export interface PullRequestTarget {
  platform: CodeHost;
  host: string;
  /** GitHub owner or GitLab namespace (including any nested groups). */
  owner: string;
  repository: string;
  number: number;
  canonicalUrl: string;
  label: string;
  source: PullRequestTargetSource;
}

export interface RepositoryIdentity {
  platform: CodeHost;
  host: string;
  owner: string;
  repository: string;
  path: string;
}

const REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/;
const GITHUB_SHORTHAND = /^([^#!\s]+\/[^#!\s]+)#([1-9]\d*)$/;
const GITLAB_SHORTHAND = /^([^#!\s]+\/[^#!\s]+)!([1-9]\d*)$/;
const NUMBER_PATTERN = /^#?([1-9]\d*)$/;

export function parsePullRequestTarget(input: unknown, checkoutRepository?: string): PullRequestTarget {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Paste a GitHub pull request or GitLab merge request URL, or enter a request number.");
  }

  const value = input.trim();
  const urlTarget = parseCodeHostUrl(value);
  if (urlTarget) return target(urlTarget, "url");

  const gitLabShorthand = GITLAB_SHORTHAND.exec(value);
  if (gitLabShorthand) {
    const repository = parseRepositoryPath(gitLabShorthand[1]!);
    if (!repository) throw new Error("That GitLab merge request shorthand is not valid.");
    return target({ platform: "gitlab", host: "gitlab.com", ...repository, number: positiveInteger(gitLabShorthand[2]!) }, "shorthand");
  }

  const gitHubShorthand = GITHUB_SHORTHAND.exec(value);
  if (gitHubShorthand) {
    const repository = parseRepositoryPath(gitHubShorthand[1]!);
    if (!repository || repository.owner.includes("/")) throw new Error("That GitHub pull request shorthand is not valid.");
    return target({ platform: "github", host: "github.com", ...repository, number: positiveInteger(gitHubShorthand[2]!) }, "shorthand");
  }

  const number = NUMBER_PATTERN.exec(value);
  if (number) {
    const repository = repositoryIdentityFromCheckout(checkoutRepository);
    if (!repository) {
      throw new Error("A request number requires a GitHub or GitLab repository checkout. Paste the full URL instead.");
    }
    return target({ ...repository, number: positiveInteger(number[1]!) }, "checkout");
  }

  throw new Error("Use a GitHub pull request URL, GitLab merge request URL, owner/repo#123, namespace/repo!123, or a request number.");
}

export function repositoryIdentityFromRemoteUrl(remote: string | undefined): RepositoryIdentity | undefined {
  if (!remote?.trim()) return undefined;
  const value = remote.trim().replace(/\/$/, "").replace(/\.git$/, "");

  const scpMatch = /^git@([^:]+):(.+)$/i.exec(value);
  if (scpMatch) return repositoryIdentity(scpMatch[1]!, scpMatch[2]!);

  try {
    const url = new URL(value);
    if (!url.hostname) return undefined;
    // The API is reached over HTTPS on the default port, so an HTTP(S) remote on another port names a different service.
    if (url.port && /^https?:$/.test(url.protocol)) return undefined;
    return repositoryIdentity(url.hostname, url.pathname.replace(/^\//, ""));
  } catch {
    return undefined;
  }
}

export function repositoryFromRemoteUrl(remote: string | undefined): string | undefined {
  return repositoryIdentityFromRemoteUrl(remote)?.path;
}

export function targetRepositoryPath(target: PullRequestTarget): string {
  return `${target.owner}/${target.repository}`;
}

export function targetRepositoryKey(target: PullRequestTarget): string {
  const repositoryPath = targetRepositoryPath(target);
  return target.platform === "github" ? repositoryPath : `${target.host}/${repositoryPath}`;
}

export function codeHostName(target: Pick<PullRequestTarget, "platform">): "GitHub" | "GitLab" {
  return target.platform === "gitlab" ? "GitLab" : "GitHub";
}

function parseCodeHostUrl(value: string): (RepositoryIdentity & { number: number }) | undefined {
  if (!/^https?:\/\//i.test(value)) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("That code review URL is not valid.");
  }
  if (url.protocol !== "https:") throw new Error("Wingdiff only supports HTTPS code review URLs.");
  if (url.port) throw new Error("Wingdiff does not support code review URLs with a custom port.");

  const hostname = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (hostname === "github.com" || hostname === "www.github.com") {
    if (parts.length < 4 || parts[2] !== "pull") {
      throw new Error("Paste a GitHub pull request URL such as https://github.com/owner/repo/pull/123.");
    }
    const repository = parseRepositoryPath(`${parts[0]}/${parts[1]}`);
    if (!repository || repository.owner.includes("/") || !/^[1-9]\d*$/.test(parts[3]!)) {
      throw new Error("That GitHub pull request URL is not valid.");
    }
    return { platform: "github", host: "github.com", ...repository, number: positiveInteger(parts[3]!) };
  }

  if (!isTrustedGitLabHost(hostname)) {
    throw new Error(
      `Wingdiff only supports github.com, gitlab.com, and GitLab hosts listed in WINGDIFF_GITLAB_HOSTS (got ${hostname}).`,
    );
  }
  const marker = parts.lastIndexOf("-");
  if (marker < 2 || parts[marker + 1] !== "merge_requests" || !/^[1-9]\d*$/.test(parts[marker + 2] ?? "")) {
    throw new Error("Paste a GitLab merge request URL such as https://gitlab.com/group/repo/-/merge_requests/123.");
  }
  const repository = parseRepositoryPath(parts.slice(0, marker).join("/"));
  if (!repository) throw new Error("That GitLab merge request URL is not valid.");
  return { platform: "gitlab", host: hostname, ...repository, number: positiveInteger(parts[marker + 2]!) };
}

function repositoryIdentityFromCheckout(value: string | undefined): RepositoryIdentity | undefined {
  const remote = repositoryIdentityFromRemoteUrl(value);
  if (remote) return remote;
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("gitlab:")) {
    const repository = parseRepositoryPath(trimmed.slice("gitlab:".length));
    return repository ? { platform: "gitlab", host: "gitlab.com", ...repository } : undefined;
  }
  const repository = parseRepositoryPath(trimmed);
  return repository && !repository.owner.includes("/")
    ? { platform: "github", host: "github.com", ...repository }
    : undefined;
}

function repositoryIdentity(host: string, repositoryPath: string): RepositoryIdentity | undefined {
  const normalizedHost = host.toLowerCase();
  const repository = parseRepositoryPath(repositoryPath);
  if (!repository) return undefined;
  if (normalizedHost === "github.com" || normalizedHost === "www.github.com") {
    if (repository.owner.includes("/")) return undefined;
    return { platform: "github", host: "github.com", ...repository };
  }
  // Only trusted GitLab hosts are accepted, so glab never sends credentials to an arbitrary host.
  if (!isTrustedGitLabHost(normalizedHost)) return undefined;
  return { platform: "gitlab", host: normalizedHost, ...repository };
}

/** gitlab.com, plus self-managed hosts the user lists (comma-separated) in WINGDIFF_GITLAB_HOSTS. */
export function isTrustedGitLabHost(host: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  return trustedGitLabHosts(environment).includes(host.toLowerCase());
}

export function trustedGitLabHosts(environment: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (environment.WINGDIFF_GITLAB_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(["gitlab.com", ...configured])];
}

function parseRepositoryPath(value: string | undefined): { owner: string; repository: string; path: string } | undefined {
  if (!value) return undefined;
  const parts = value.trim().replace(/^\//, "").replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2 || parts.some((part) => !REPOSITORY_SEGMENT.test(part) || part === "." || part === "..")) return undefined;
  const repository = parts.at(-1)!;
  const owner = parts.slice(0, -1).join("/");
  return { owner, repository, path: `${owner}/${repository}` };
}

function positiveInteger(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("The request number is not valid.");
  return number;
}

function target(value: RepositoryIdentity & { number: number }, source: PullRequestTargetSource): PullRequestTarget {
  const canonicalUrl = value.platform === "github"
    ? `https://github.com/${value.path}/pull/${value.number}`
    : `https://${value.host}/${value.path}/-/merge_requests/${value.number}`;
  return {
    platform: value.platform,
    host: value.host,
    owner: value.owner,
    repository: value.repository,
    number: value.number,
    canonicalUrl,
    label: `${value.path}${value.platform === "gitlab" ? "!" : "#"}${value.number}`,
    source,
  };
}
