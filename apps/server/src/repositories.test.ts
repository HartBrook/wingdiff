import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedRepositoryPath, prepareRepositoryTarget, resolveRepositoryTarget, type RepositoryResolutionDependencies } from "./repositories.js";
import { parsePullRequestTarget } from "./targets.js";

const target = parsePullRequestTarget("https://github.com/OpenAI/Codex/pull/42");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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

  it("uses glab and a host-scoped cache for a GitLab project", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wingdiff-repositories-"));
    temporaryDirectories.push(directory);
    vi.stubEnv("WINGDIFF_GITLAB_HOSTS", "gitlab.example.com");
    const gitLabTarget = parsePullRequestTarget("https://gitlab.example.com/acme/platform/service/-/merge_requests/42");
    const dependencies = fixtureDependencies({ status: "not-found" });
    dependencies.inspectTarget = async () => ({
      checkout: { status: "not-found" },
      hostingCli: { provider: "gitlab", command: "glab", installed: true, supported: true, version: "1.100.0", authenticated: true },
      networkChecked: false,
    });
    let invocation: { command: string; arguments_: string[] } | undefined;
    dependencies.runCommand = async (command, arguments_) => {
      invocation = { command, arguments_ };
      await mkdir(arguments_[3]!, { recursive: true });
      return "";
    };
    const environment = { WINGDIFF_DATA_DIR: directory };
    const expected = path.join(directory, "repositories", "gitlab", "gitlab.example.com", "acme", "platform", "service.git");

    await expect(resolveRepositoryTarget(gitLabTarget, "/tmp", environment, dependencies)).resolves.toBe(expected);
    expect(invocation).toEqual({
      command: "glab",
      arguments_: ["repo", "clone", "https://gitlab.example.com/acme/platform/service", expect.stringContaining("service.git.tmp-"), "--", "--bare", "--filter=blob:none"],
    });
  });
});

function fixtureDependencies(checkout: Awaited<ReturnType<RepositoryResolutionDependencies["inspectTarget"]>>["checkout"]): RepositoryResolutionDependencies {
  return {
    inspectTarget: async () => ({
      checkout,
      hostingCli: { provider: "github", command: "gh", installed: true, supported: true, authenticated: true },
      networkChecked: false,
    }),
    runCommand: async () => "",
  };
}
