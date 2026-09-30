import { describe, expect, it } from "vitest";
import { acquisitionBlocker, addRecentTarget, parseLaunchRoute, type PullRequestTarget, type TargetPreparation } from "./launcher";

const target: PullRequestTarget = {
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

  it("explains why an external pull request cannot open from the attached checkout", () => {
    const preparation: TargetPreparation = {
      target,
      environment: {
        checkout: { status: "different", path: "/work/wingdiff", repository: "HartBrook/wingdiff" },
        githubCli: { installed: true, authenticated: true },
        networkChecked: false,
      },
    };
    expect(acquisitionBlocker(preparation)).toMatch(/--checkout.*openai\/codex.*HartBrook\/wingdiff/);
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
        githubCli: { installed: true, authenticated: false },
        networkChecked: false,
      },
    };
    expect(acquisitionBlocker(preparation)).toMatch(/gh auth login/);
  });
});
