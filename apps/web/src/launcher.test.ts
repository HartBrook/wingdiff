import { describe, expect, it } from "vitest";
import { acquisitionBlocker, addRecentTarget, parseLaunchRoute, type PullRequestTarget, type TargetPreparation } from "./launcher";

const target: PullRequestTarget = {
  platform: "github",
  host: "github.com",
  owner: "openai",
  repository: "codex",
  number: 42,
  canonicalUrl: "https://github.com/openai/codex/pull/42",
  label: "openai/codex#42",
  source: "url",
};

describe("launcher state", () => {
  it("reads demo and target routes", () => {
    expect(parseLaunchRoute("?demo=1")).toEqual({ demo: true });
    expect(parseLaunchRoute("?target=https%3A%2F%2Fgithub.com%2Fopenai%2Fcodex%2Fpull%2F42")).toEqual({
      demo: false,
      target: target.canonicalUrl,
    });
    expect(parseLaunchRoute("?session=local-123")).toEqual({ demo: false, session: "local-123" });
  });

  it("deduplicates and limits recent targets", () => {
    const older = Array.from({ length: 6 }, (_, index) => ({
      ...target,
      number: index + 1,
      canonicalUrl: `https://github.com/openai/codex/pull/${index + 1}`,
      label: `openai/codex#${index + 1}`,
    }));
    const recent = addRecentTarget(older, target);
    expect(recent).toHaveLength(5);
    expect(recent[0]).toBe(target);
    expect(new Set(recent.map((candidate) => candidate.canonicalUrl)).size).toBe(5);
  });

  it("allows an external pull request through the managed repository cache", () => {
    const preparation: TargetPreparation = {
      target,
      environment: {
        checkout: { status: "different", path: "/work/wingdiff", repository: "HartBrook/wingdiff" },
        hostingCli: { provider: "github", command: "gh", installed: true, supported: true, authenticated: true },
        networkChecked: false,
      },
    };
    expect(acquisitionBlocker(preparation)).toBeUndefined();
    expect(acquisitionBlocker({
      ...preparation,
      environment: { ...preparation.environment, checkout: { status: "matched", path: "/work/codex" } },
    })).toBeUndefined();
  });

  it("gives an actionable authentication command", () => {
    const preparation: TargetPreparation = {
      target,
      environment: {
        checkout: { status: "matched", path: "/work/codex", repository: "openai/codex" },
        hostingCli: { provider: "github", command: "gh", installed: true, supported: true, authenticated: false },
        networkChecked: false,
      },
    };
    expect(acquisitionBlocker(preparation)).toMatch(/gh auth login/);
  });

  it("gives GitLab-specific setup guidance", () => {
    const preparation: TargetPreparation = {
      target: {
        ...target,
        platform: "gitlab",
        host: "gitlab.example.com",
        owner: "acme/platform",
        canonicalUrl: "https://gitlab.example.com/acme/platform/codex/-/merge_requests/42",
        label: "acme/platform/codex!42",
      },
      environment: {
        checkout: { status: "managed" },
        hostingCli: { provider: "gitlab", command: "glab", installed: true, supported: true, version: "1.100.0", authenticated: false },
        networkChecked: false,
      },
    };
    expect(acquisitionBlocker(preparation)).toBe("GitLab CLI is not authenticated. Run: glab auth login --hostname gitlab.example.com");
  });

  it("blocks an outdated GitLab CLI before acquisition", () => {
    const preparation: TargetPreparation = {
      target: { ...target, platform: "gitlab", host: "gitlab.com" },
      environment: {
        checkout: { status: "managed" },
        hostingCli: {
          provider: "gitlab", command: "glab", installed: true, supported: false, version: "1.99.0", authenticated: true,
        },
        networkChecked: false,
      },
    };
    expect(acquisitionBlocker(preparation)).toMatch(/1\.100\.0 or later.*Found 1\.99\.0/);
  });
});
