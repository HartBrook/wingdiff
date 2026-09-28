import { describe, expect, it } from "vitest";
import { parsePullRequestTarget, repositoryFromRemoteUrl } from "./targets.js";

describe("pull request targets", () => {
  it("normalizes a GitHub URL and ignores its view fragment", () => {
    expect(parsePullRequestTarget("https://github.com/openai/codex/pull/842/files#diff-abc")).toEqual({
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

  it("requires checkout context for a bare number", () => {
    expect(() => parsePullRequestTarget("42")).toThrow(/requires a GitHub repository checkout/);
  });

  it("rejects deceptive hosts and non-PR URLs", () => {
    expect(() => parsePullRequestTarget("https://github.com.example.com/openai/codex/pull/42")).toThrow(/github.com/);
    expect(() => parsePullRequestTarget("https://github.com/openai/codex/issues/42")).toThrow(/pull request URL/);
    expect(() => parsePullRequestTarget("https://gitlab.com/openai/codex/pull/42")).toThrow(/github.com/);
  });

  it("extracts GitHub repository names from common remotes", () => {
    expect(repositoryFromRemoteUrl("git@github.com:openai/codex.git")).toBe("openai/codex");
    expect(repositoryFromRemoteUrl("https://github.com/openai/codex.git")).toBe("openai/codex");
    expect(repositoryFromRemoteUrl("ssh://git@github.com/openai/codex.git")).toBe("openai/codex");
    expect(repositoryFromRemoteUrl("https://example.com/openai/codex.git")).toBeUndefined();
  });
});
