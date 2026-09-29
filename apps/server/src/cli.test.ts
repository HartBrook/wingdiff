import { describe, expect, it } from "vitest";
import { browserInvocation, launchUrl, parseCliArguments } from "./cli.js";

describe("wingdiff CLI", () => {
  it("accepts an optional target and launcher flags", () => {
    expect(parseCliArguments([])).toEqual({ demo: false, openBrowser: true, help: false });
    expect(parseCliArguments(["openai/codex#42", "--no-open"])).toEqual({
      target: "openai/codex#42",
      demo: false,
      openBrowser: false,
      help: false,
    });
    expect(parseCliArguments(["--demo"])).toMatchObject({ demo: true });
  });

  it("rejects conflicting or unknown arguments", () => {
    expect(() => parseCliArguments(["--wat"])).toThrow(/Unknown option/);
    expect(() => parseCliArguments(["--demo", "openai/codex#42"])).toThrow(/either --demo/);
    expect(() => parseCliArguments(["one", "two"])).toThrow(/one pull request target/);
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
});
