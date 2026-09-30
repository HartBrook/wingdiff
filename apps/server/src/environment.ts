import path from "node:path";
import { loadEnvFile } from "node:process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function defaultConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  homeDirectory = homedir(),
): string {
  if (environment.WINGDIFF_CONFIG) return path.resolve(environment.WINGDIFF_CONFIG);
  if (environment.XDG_CONFIG_HOME) return path.join(environment.XDG_CONFIG_HOME, "wingdiff", "config.env");
  if (platform === "darwin") return path.join(homeDirectory, "Library", "Application Support", "wingdiff", "config.env");
  if (platform === "win32") {
    const applicationData = environment.APPDATA ?? environment.LOCALAPPDATA;
    if (applicationData) return path.join(applicationData, "wingdiff", "config.env");
  }
  return path.join(homeDirectory, ".config", "wingdiff", "config.env");
}

export function loadWingdiffEnvironment() {
  loadOptionalEnvironmentFile(path.join(repositoryRoot, ".env"));
  loadOptionalEnvironmentFile(defaultConfigPath());
}

function loadOptionalEnvironmentFile(filePath: string) {
  try {
    loadEnvFile(filePath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}
