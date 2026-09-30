import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfigPath } from "./environment.js";

describe("Wingdiff configuration", () => {
  it("uses platform-native user configuration paths", () => {
    expect(defaultConfigPath({}, "darwin", "/Users/reviewer"))
      .toBe(path.join("/Users/reviewer", "Library", "Application Support", "wingdiff", "config.env"));
    expect(defaultConfigPath({}, "linux", "/home/reviewer"))
      .toBe(path.join("/home/reviewer", ".config", "wingdiff", "config.env"));
    expect(defaultConfigPath({ APPDATA: "C:\\Users\\reviewer\\AppData\\Roaming" }, "win32", "C:\\Users\\reviewer"))
      .toBe(path.join("C:\\Users\\reviewer\\AppData\\Roaming", "wingdiff", "config.env"));
  });

  it("supports explicit and XDG overrides", () => {
    expect(defaultConfigPath({ WINGDIFF_CONFIG: "/private/wingdiff.env" }, "linux", "/home/reviewer"))
      .toBe(path.resolve("/private/wingdiff.env"));
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/config" }, "linux", "/home/reviewer"))
      .toBe(path.join("/config", "wingdiff", "config.env"));
  });
});
