import { afterEach, describe, expect, it, vi } from "vitest";
import { isTrustedGitLabHost, parsePullRequestTarget, repositoryFromRemoteUrl } from "./targets.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pull request targets", () => {
  it("normalizes a GitHub URL and ignores its view fragment", () => {
    expect(parsePullRequestTarget("https://github.com/openai/codex/pull/842/files#diff-abc")).toEqual({
      platform: "github",
      host: "github.com",
      owner: "openai",
      repository: "codex",
      number: 842,
      canonicalUrl: "https://github.com/openai/codex/pull/842",
      label: "openai/codex#842",
      source: "url",
    });
  });

  it("accepts repository and checkout shorthand", () => {
    expect(parsePullRequestTarget("openai/codex#42").canonicalUrl).toBe("https://github.com/openai/codex/pull/42");
    expect(parsePullRequestTarget("#42", "openai/codex")).toMatchObject({ number: 42, source: "checkout" });
    expect(parsePullRequestTarget("42", "openai/codex")).toMatchObject({ number: 42, source: "checkout" });
  });

  it("rejects slash-heavy malformed shorthand without expensive backtracking", () => {
    const slashHeavyPath = "group/".repeat(10_000);
    expect(() => parsePullRequestTarget(`${slashHeavyPath}repo#not-a-number`)).toThrow(/Use a GitHub pull request URL/);
    expect(() => parsePullRequestTarget(`${slashHeavyPath}repo!not-a-number`)).toThrow(/Use a GitHub pull request URL/);
  });

  it("normalizes GitLab merge requests with nested groups", () => {
    expect(parsePullRequestTarget("https://gitlab.com/acme/platform/service/-/merge_requests/42/diffs#note_1")).toEqual({
      platform: "gitlab",
      host: "gitlab.com",
      owner: "acme/platform",
      repository: "service",
      number: 42,
      canonicalUrl: "https://gitlab.com/acme/platform/service/-/merge_requests/42",
      label: "acme/platform/service!42",
      source: "url",
    });
    expect(parsePullRequestTarget("acme/platform/service!42")).toMatchObject({
      platform: "gitlab", owner: "acme/platform", repository: "service", number: 42,
    });
    expect(parsePullRequestTarget("42", "git@gitlab.com:acme/platform/service.git")).toMatchObject({
      platform: "gitlab", owner: "acme/platform", repository: "service", source: "checkout",
    });
  });

  it("requires checkout context for a bare number", () => {
    expect(() => parsePullRequestTarget("42")).toThrow(/requires a GitHub or GitLab repository checkout/);
  });

  it("rejects deceptive hosts and non-PR URLs", () => {
    expect(() => parsePullRequestTarget("https://github.com.example.com/openai/codex/pull/42")).toThrow(/WINGDIFF_GITLAB_HOSTS/);
    expect(() => parsePullRequestTarget("https://github.com/openai/codex/issues/42")).toThrow(/pull request URL/);
    expect(() => parsePullRequestTarget("https://gitlab.com/openai/codex/pull/42")).toThrow(/GitLab merge request URL/);
  });

  it("extracts GitHub repository names from common remotes", () => {
    expect(repositoryFromRemoteUrl("git@github.com:openai/codex.git")).toBe("openai/codex");
    expect(repositoryFromRemoteUrl("https://github.com/openai/codex.git")).toBe("openai/codex");
    expect(repositoryFromRemoteUrl("ssh://git@github.com/openai/codex.git")).toBe("openai/codex");
    expect(repositoryFromRemoteUrl("git@gitlab.com:acme/platform/service.git")).toBe("acme/platform/service");
    expect(repositoryFromRemoteUrl("https://gitlab.example.com/acme/service.git")).toBeUndefined();
    vi.stubEnv("WINGDIFF_GITLAB_HOSTS", "gitlab.example.com");
    expect(repositoryFromRemoteUrl("https://gitlab.example.com/acme/service.git")).toBe("acme/service");
  });

  it("rejects HTTPS URLs and remotes on a custom port", () => {
    vi.stubEnv("WINGDIFF_GITLAB_HOSTS", "gitlab.example.com");
    expect(() => parsePullRequestTarget("https://gitlab.example.com:8443/acme/service/-/merge_requests/1")).toThrow(/custom port/);
    expect(repositoryFromRemoteUrl("https://gitlab.example.com:8443/acme/service.git")).toBeUndefined();
    expect(repositoryFromRemoteUrl("ssh://git@gitlab.example.com:2222/acme/service.git")).toBe("acme/service");
  });

  it("only trusts gitlab.com and configured self-managed GitLab hosts", () => {
    expect(isTrustedGitLabHost("gitlab.com", {})).toBe(true);
    expect(isTrustedGitLabHost("attacker.example", {})).toBe(false);
    expect(isTrustedGitLabHost("Git.Corp.Example", { WINGDIFF_GITLAB_HOSTS: "gitlab.example.com, git.corp.example" })).toBe(true);
    expect(() => parsePullRequestTarget("https://attacker.example/a/b/-/merge_requests/1")).toThrow(/WINGDIFF_GITLAB_HOSTS/);
    expect(repositoryFromRemoteUrl("git@github-work:owner/repo.git")).toBeUndefined();
  });
});
