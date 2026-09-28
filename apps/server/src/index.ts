import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApp } from "./app.js";

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
  const configured = [process.env.OPENAI_API_KEY && "OpenAI", process.env.ANTHROPIC_API_KEY && "Anthropic"].filter(Boolean);
  console.log(`wingdiff is ready at http://${host}:${port}`);
  console.log(configured.length ? `AI providers: ${configured.join(", ")}` : "AI providers: fixture mode (set OPENAI_API_KEY or ANTHROPIC_API_KEY)");
});
