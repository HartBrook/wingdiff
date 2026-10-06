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
      hostingCli: { provider: "github", command: "gh", installed: true, supported: true, authenticated: true },
      networkChecked: false,
    });
  });

  it("distinguishes an installed GitHub CLI from an authenticated one", async () => {
    const runner: CommandRunner = async (command, arguments_) => {
      if (command === "gh" && arguments_[0] === "auth") throw new Error("logged out");
      if (command === "gh") return "gh version 2";
      if (arguments_[0] === "rev-parse") return "/work/codex\n";
      return "git@github.com:openai/codex.git\n";
    };

    expect((await inspectLocalTarget(target, "/work/codex", runner)).hostingCli).toEqual({
      provider: "github",
      command: "gh",
      installed: true,
      supported: true,
      authenticated: false,
    });
  });

  it("uses glab and recognizes nested GitLab checkout remotes", async () => {
    const gitLabTarget = parsePullRequestTarget("https://gitlab.com/acme/platform/service/-/merge_requests/42");
    const calls: Array<[string, string[]]> = [];
    const runner: CommandRunner = async (command, arguments_) => {
      calls.push([command, arguments_]);
      if (command === "glab") return "glab 1.100.0 (abc123)";
      if (arguments_[0] === "rev-parse") return "/work/service\n";
      return "git@gitlab.com:acme/platform/service.git\n";
    };
    const result = await inspectLocalTarget(gitLabTarget, "/work/service", runner);
    expect(result.checkout).toEqual({ status: "matched", path: "/work/service", repository: "acme/platform/service" });
    expect(result.hostingCli).toEqual({
      provider: "gitlab", command: "glab", installed: true, supported: true, version: "1.100.0", authenticated: true,
    });
    expect(calls).toContainEqual(["glab", ["auth", "status", "--hostname", "gitlab.com"]]);
  });

  it("reports an installed GitLab CLI below the supported minimum", async () => {
    const gitLabTarget = parsePullRequestTarget("https://gitlab.com/acme/service/-/merge_requests/42");
    const runner: CommandRunner = async (command, arguments_) => {
      if (command === "glab" && arguments_[0] === "--version") return "glab 1.99.0";
      if (command === "glab") return "authenticated";
      if (arguments_[0] === "rev-parse") return "/work/service\n";
      return "git@gitlab.com:acme/service.git\n";
    };

    expect((await inspectLocalTarget(gitLabTarget, "/work/service", runner)).hostingCli).toEqual({
      provider: "gitlab", command: "glab", installed: true, supported: false, version: "1.99.0", authenticated: true,
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
