import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApp } from "./app.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
try {
  loadEnvFile(path.join(repositoryRoot, ".env"));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code !== "ENOENT") throw error;
}

const host = process.env.WINGDIFF_HOST ?? "127.0.0.1";
const port = Number(process.env.WINGDIFF_PORT ?? 4173);
const app = createApp();

if (process.env.NODE_ENV === "development") {
  const { createServer } = await import("vite");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  app.use(express.static(webDist));
  app.get("/{*path}", (_request, response) => response.sendFile(path.join(webDist, "index.html")));
}

app.listen(port, host, () => {
  console.log(`wingdiff is ready at http://${host}:${port}`);
  console.log("AI providers: see the in-app provider picker for local availability");
});
