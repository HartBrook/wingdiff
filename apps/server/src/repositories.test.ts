import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { managedRepositoryPath, prepareRepositoryTarget, resolveRepositoryTarget, type RepositoryResolutionDependencies } from "./repositories.js";
import { parsePullRequestTarget } from "./targets.js";

const target = parsePullRequestTarget("https://github.com/OpenAI/Codex/pull/42");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("repository resolution", () => {
  it("uses a matching launch checkout without cloning", async () => {
    const dependencies = fixtureDependencies({ status: "matched", path: "/work/codex", repository: "OpenAI/Codex" });
    await expect(resolveRepositoryTarget(target, "/work/codex", {}, dependencies)).resolves.toBe("/work/codex");
  });

  it("prepares a managed cache without making a network request", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wingdiff-repositories-"));
    temporaryDirectories.push(directory);
    const dependencies = fixtureDependencies({ status: "not-found" });
    const preparation = await prepareRepositoryTarget(target, "/tmp", { WINGDIFF_DATA_DIR: directory }, dependencies);
    expect(preparation.checkout).toEqual({ status: "managed", repository: "OpenAI/Codex" });
  });

  it("clones and reuses a private bare cache", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wingdiff-repositories-"));
    temporaryDirectories.push(directory);
    let cloneCount = 0;
    const dependencies = fixtureDependencies({ status: "different", path: "/work/wingdiff", repository: "HartBrook/wingdiff" });
    dependencies.runCommand = async (_command, arguments_) => {
      cloneCount += 1;
      await mkdir(arguments_[3]!, { recursive: true });
      return "";
    };
    const environment = { WINGDIFF_DATA_DIR: directory };
    const expected = path.join(directory, "repositories", "openai", "codex.git");

    await expect(resolveRepositoryTarget(target, "/work/wingdiff", environment, dependencies)).resolves.toBe(expected);
    await expect(resolveRepositoryTarget(target, "/work/wingdiff", environment, dependencies)).resolves.toBe(expected);
    expect(cloneCount).toBe(1);
    expect(managedRepositoryPath(target, environment)).toBe(expected);
  });
});

function fixtureDependencies(checkout: Awaited<ReturnType<RepositoryResolutionDependencies["inspectTarget"]>>["checkout"]): RepositoryResolutionDependencies {
  return {
    inspectTarget: async () => ({
      checkout,
      githubCli: { installed: true, authenticated: true },
      networkChecked: false,
    }),
    runCommand: async () => "",
  };
}
