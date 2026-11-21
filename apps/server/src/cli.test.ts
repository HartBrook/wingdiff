import { describe, expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { browserInvocation, diagnoseEnvironment, inferPullRequestTarget, isDirectCliInvocation, launchUrl, launchUrlForDisplay, parseCliArguments, resolveWorkingDirectory } from "./cli.js";

describe("wingdiff CLI", () => {
  it("recognizes npm's symlinked executable as the CLI entrypoint", () => {
    const modulePath = path.resolve("package", "apps", "server", "dist", "cli.js");
    const executablePath = path.resolve("package", "node_modules", ".bin", "wingdiff");
    const canonicalPath = path.resolve("registry", "wingdiff", "apps", "server", "dist", "cli.js");
    const resolveRealPath = (filePath: string) => filePath === modulePath || filePath === executablePath
      ? canonicalPath
      : filePath;

    expect(isDirectCliInvocation(pathToFileURL(modulePath).href, executablePath, resolveRealPath)).toBe(true);
    expect(isDirectCliInvocation(pathToFileURL(modulePath).href, path.resolve("other", "wingdiff"), resolveRealPath)).toBe(false);
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
    expect(() => parseCliArguments(["one", "two"])).toThrow(/one review target/);
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
        platform: "github",
        host: "github.com",
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

  it("redacts the launch token from normal terminal output", () => {
    const url = "http://127.0.0.1:4173/?target=acme%2Frepo%231&wingdiff_token=local-secret";
    expect(launchUrlForDisplay(url, true)).toBe("http://127.0.0.1:4173/?target=acme%2Frepo%231");
    expect(launchUrlForDisplay(url, false)).toBe(url);
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

  it("infers the merge request for a GitLab checkout", async () => {
    const calls: string[] = [];
    const target = await inferPullRequestTarget("/work/service", async (command, arguments_) => {
      calls.push(`${command} ${arguments_.join(" ")}`);
      if (command === "git") return "git@gitlab.com:acme/platform/service.git\n";
      return "https://gitlab.com/acme/platform/service/-/merge_requests/42\n";
    });
    expect(target).toBe("https://gitlab.com/acme/platform/service/-/merge_requests/42");
    expect(calls).toContain("glab mr view --output json --jq .web_url");
  });

  it("falls back to the launcher when no current pull request can be inferred", async () => {
    await expect(inferPullRequestTarget("/tmp", async () => { throw new Error("not a repository"); }))
      .resolves.toBeUndefined();
  });

  it("reports actionable environment diagnostics", async () => {
    const checks = await diagnoseEnvironment("/work/codex", {}, async (command, arguments_) => {
      if (command === "codex") throw new Error("missing");
      if (command === "gh" && arguments_[0] === "auth") throw new Error("logged out");
      if (command === "glab" && arguments_[0] === "--version") return "glab 1.100.0";
      return "ok";
    });
    expect(checks).toEqual([
      { label: "Git", ok: true, detail: "installed" },
      { label: "Code host", ok: true, detail: "GitHub needs: gh auth login; GitLab authenticated (gitlab.com)" },
      { label: "AI provider", ok: false, detail: "not configured; run: codex login" },
    ]);
  });

  it("checks each trusted GitLab host separately so one stale login does not hide another", async () => {
    const checks = await diagnoseEnvironment("/work/codex", { WINGDIFF_GITLAB_HOSTS: "gitlab.example.com" }, async (command, arguments_) => {
      const hostnameIndex = arguments_.indexOf("--hostname");
      if (command === "glab" && arguments_[0] === "auth" && arguments_[hostnameIndex + 1] !== "gitlab.example.com") throw new Error("stale");
      if (command === "glab" && arguments_[0] === "--version") return "glab 1.100.0";
      if (command === "gh" && arguments_[0] === "auth") throw new Error("logged out");
      return "ok";
    });
    expect(checks[1]).toEqual({ label: "Code host", ok: true, detail: "GitHub needs: gh auth login; GitLab authenticated (gitlab.example.com)" });
  });

  it("reports an authenticated but outdated GitLab CLI as unavailable", async () => {
    const checks = await diagnoseEnvironment("/work/service", {}, async (command, arguments_) => {
      if (command === "gh" || command === "codex") throw new Error("missing");
      if (command === "glab" && arguments_[0] === "--version") return "glab 1.99.0";
      return "ok";
    });
    expect(checks[1]).toEqual({
      label: "Code host", ok: false, detail: "GitLab needs glab 1.100.0+ (found 1.99.0)",
    });
  });
});
