import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "wingdiff-package-"));

try {
  await execFile("npm", ["pack", "--silent", "--pack-destination", temporaryRoot], {
    cwd: repositoryRoot,
  });
  const tarballs = (await readdir(temporaryRoot)).filter((fileName) => fileName.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`Expected one package tarball, found ${tarballs.length}.`);

  const installationRoot = path.join(temporaryRoot, "installation");
  await mkdir(installationRoot);
  await execFile("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installationRoot,
    path.join(temporaryRoot, tarballs[0]),
  ], { cwd: repositoryRoot });

  const binaryName = process.platform === "win32" ? "wingdiff.cmd" : "wingdiff";
  const binaryPath = path.join(installationRoot, "node_modules", ".bin", binaryName);
  const executionOptions = {
    cwd: installationRoot,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    shell: process.platform === "win32",
  };
  const { stdout: versionOutput } = await execFile(binaryPath, ["--version"], executionOptions);
  if (versionOutput.trim() !== manifest.version) {
    throw new Error(`Expected wingdiff --version to print ${manifest.version}, received ${JSON.stringify(versionOutput.trim())}.`);
  }

  const { stdout: helpOutput } = await execFile(binaryPath, ["--help"], executionOptions);
  if (!helpOutput.includes("wingdiff — guided code review") || !helpOutput.includes("Usage:")) {
    throw new Error("Installed wingdiff --help output is incomplete.");
  }

  process.stdout.write(`Verified packed wingdiff@${manifest.version}: --version and --help succeeded.\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
