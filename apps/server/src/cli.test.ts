import { describe, expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { browserInvocation, diagnoseEnvironment, inferPullRequestTarget, isDirectCliInvocation, launchUrl, parseCliArguments, resolveWorkingDirectory } from "./cli.js";

describe("wingdiff CLI", () => {
  it("recognizes npm's symlinked executable as the CLI entrypoint", () => {
    const modulePath = "/package/apps/server/dist/cli.js";
    const executablePath = "/package/node_modules/.bin/wingdiff";
    const canonicalPath = "/registry/wingdiff/apps/server/dist/cli.js";
    const resolveRealPath = (filePath: string) => filePath === modulePath || filePath === executablePath
      ? canonicalPath
      : filePath;

    expect(isDirectCliInvocation(pathToFileURL(modulePath).href, executablePath, resolveRealPath)).toBe(true);
    expect(isDirectCliInvocation(pathToFileURL(modulePath).href, "/other/wingdiff", resolveRealPath)).toBe(false);
    expect(isDirectCliInvocation(pathToFileURL(modulePath).href, undefined, resolveRealPath)).toBe(false);
  });

  it("accepts an optional target and launcher flags", () => {
    expect(parseCliArguments([])).toEqual({ command: "open", demo: false, openBrowser: true, help: false, version: false });
    expect(parseCliArguments(["openai/codex#42", "--no-open"])).toEqual({
      command: "open",
      target: "openai/codex#42",
      demo: false,
      openBrowser: false,
      help: false,
      version: false,
    });
    expect(parseCliArguments(["--checkout", "../codex", "openai/codex#42"])).toEqual({
      command: "open",
      target: "openai/codex#42",
      checkout: "../codex",
      demo: false,
      openBrowser: true,
      help: false,
      version: false,
    });
    expect(parseCliArguments(["openai/codex#42", "--checkout=../codex"])).toMatchObject({ checkout: "../codex" });
    expect(parseCliArguments(["--demo"])).toMatchObject({ demo: true });
    expect(parseCliArguments(["demo"])).toMatchObject({ command: "open", demo: true });
    expect(parseCliArguments(["doctor"])).toMatchObject({ command: "doctor" });
    expect(parseCliArguments(["stop"])).toMatchObject({ command: "stop" });
    expect(parseCliArguments(["--version"])).toMatchObject({ version: true });
  });

  it("rejects conflicting or unknown arguments", () => {
    expect(() => parseCliArguments(["--wat"])).toThrow(/Unknown option/);
    expect(() => parseCliArguments(["--checkout"])).toThrow(/requires a path/);
    expect(() => parseCliArguments(["--checkout", "one", "--checkout", "two"])).toThrow(/one checkout path/);
    expect(() => parseCliArguments(["--demo", "openai/codex#42"])).toThrow(/either demo/);
    expect(() => parseCliArguments(["one", "two"])).toThrow(/one pull request target/);
    expect(() => parseCliArguments(["doctor", "--no-open"])).toThrow(/does not accept/);
  });

  it("prefers an explicit checkout and otherwise preserves npm's launch directory", () => {
    expect(resolveWorkingDirectory("../selected", "/work/caller", "/work/wingdiff/apps/server"))
      .toBe(path.resolve("/work/caller", "../selected"));
    expect(resolveWorkingDirectory(undefined, "/work/caller", "/work/wingdiff/apps/server"))
      .toBe(path.resolve("/work/caller"));
    expect(resolveWorkingDirectory(undefined, undefined, "/work/wingdiff/apps/server"))
      .toBe(path.resolve("/work/wingdiff/apps/server"));
  });

  it("constructs safe browser URLs", () => {
    const url = launchUrl("http://127.0.0.1:4173", {
      demo: false,
      target: {
        owner: "openai",
        repository: "codex",
        number: 42,
        canonicalUrl: "https://github.com/openai/codex/pull/42",
        label: "openai/codex#42",
        source: "shorthand",
      },
    });
    expect(new URL(url).searchParams.get("target")).toBe("https://github.com/openai/codex/pull/42");
  });

  it("includes a one-time local authentication token", () => {
    const url = launchUrl("http://127.0.0.1:4173", { demo: false, authToken: "local-secret" });
    expect(new URL(url).searchParams.get("wingdiff_token")).toBe("local-secret");
  });

  it("uses platform-native browser launchers without a shell", () => {
    expect(browserInvocation("darwin", "http://localhost")).toEqual({ command: "open", arguments: ["http://localhost"] });
    expect(browserInvocation("linux", "http://localhost")).toEqual({ command: "xdg-open", arguments: ["http://localhost"] });
    expect(browserInvocation("win32", "http://localhost")).toEqual({ command: "cmd", arguments: ["/c", "start", "", "http://localhost"] });
  });

  it("infers the pull request for the current branch", async () => {
    const calls: string[] = [];
    const target = await inferPullRequestTarget("/work/codex", async (command, arguments_) => {
      calls.push(`${command} ${arguments_.join(" ")}`);
      if (command === "git") return "git@github.com:openai/codex.git\n";
      return "https://github.com/openai/codex/pull/42\n";
    });
    expect(target).toBe("https://github.com/openai/codex/pull/42");
    expect(calls).toEqual([
      "git config --get remote.origin.url",
      "gh pr view --json url --jq .url",
    ]);
  });

  it("falls back to the launcher when no current pull request can be inferred", async () => {
    await expect(inferPullRequestTarget("/tmp", async () => { throw new Error("not a repository"); }))
      .resolves.toBeUndefined();
  });

  it("reports actionable environment diagnostics", async () => {
    const checks = await diagnoseEnvironment("/work/codex", {}, async (command, arguments_) => {
      if (command === "codex") throw new Error("missing");
      if (command === "gh" && arguments_[0] === "auth") throw new Error("logged out");
      return "ok";
    });
    expect(checks).toEqual([
      { label: "Git", ok: true, detail: "installed" },
      { label: "GitHub CLI", ok: true, detail: "installed" },
      { label: "GitHub authentication", ok: false, detail: "not authenticated; run: gh auth login" },
      { label: "AI provider", ok: false, detail: "not configured; run: codex login" },
    ]);
  });
});
