import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function loadWingdiffEnvironment() {
  try {
    loadEnvFile(path.join(repositoryRoot, ".env"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}
