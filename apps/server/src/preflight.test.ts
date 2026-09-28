import { describe, expect, it } from "vitest";
import { inspectLocalTarget, type CommandRunner } from "./preflight.js";
import { parsePullRequestTarget } from "./targets.js";

const target = parsePullRequestTarget("https://github.com/openai/codex/pull/42");

describe("local target preflight", () => {
  it("recognizes a matching checkout without making a network request", async () => {
    const runner: CommandRunner = async (command, arguments_) => {
      if (command === "gh") return "gh version 2";
      if (arguments_[0] === "rev-parse") return "/work/codex\n";
      return "git@github.com:openai/codex.git\n";
    };

    await expect(inspectLocalTarget(target, "/work/codex", runner)).resolves.toEqual({
      checkout: { status: "matched", path: "/work/codex", repository: "openai/codex" },
      githubCli: { installed: true },
      networkChecked: false,
    });
  });

  it("distinguishes a different checkout from no checkout", async () => {
    const different: CommandRunner = async (_command, arguments_) => {
      if (arguments_[0] === "rev-parse") return "/work/wingdiff";
      if (arguments_[0] === "config") return "git@github.com:example/wingdiff.git";
      throw new Error("missing");
    };
    expect((await inspectLocalTarget(target, "/work/wingdiff", different)).checkout).toEqual({
      status: "different",
      path: "/work/wingdiff",
      repository: "example/wingdiff",
    });

    const missing: CommandRunner = async () => { throw new Error("missing"); };
    expect((await inspectLocalTarget(target, "/tmp", missing)).checkout).toEqual({ status: "not-found" });
  });
});
