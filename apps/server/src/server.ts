import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApp } from "./app.js";
import { SessionStore, defaultDatabasePath } from "./sessions.js";

export interface WingdiffServerOptions {
  environment?: NodeJS.ProcessEnv;
  host?: string;
  port?: number;
  development?: boolean;
  authToken?: string;
  cwd?: string;
}

export interface RunningWingdiffServer {
  server: Server;
  url: string;
  authToken: string;
}

export async function startWingdiffServer(options: WingdiffServerOptions = {}): Promise<RunningWingdiffServer> {
  const environment = options.environment ?? process.env;
  const host = options.host ?? environment.WINGDIFF_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host) && environment.WINGDIFF_UNSAFE_ALLOW_REMOTE !== "1") {
    throw new Error("Wingdiff only binds to loopback. Set WINGDIFF_UNSAFE_ALLOW_REMOTE=1 to acknowledge remote exposure.");
  }
  const port = options.port ?? parsePort(environment.WINGDIFF_PORT);
  const development = options.development ?? environment.NODE_ENV === "development";
  const authToken = options.authToken ?? randomBytes(32).toString("base64url");
  const sessionStore = new SessionStore(defaultDatabasePath(environment));
  const app = createApp(environment, {
    sessionStore,
    authToken,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });

  try {
    if (development) {
      const { createServer } = await import("vite");
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
      const vite = await createServer({ root, server: { middlewareMode: true }, appType: "spa" });
      app.use(vite.middlewares);
    } else {
      const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
      app.use(express.static(webDist));
      app.get("/{*path}", (_request, response) => response.sendFile(path.join(webDist, "index.html")));
    }

    const server = await new Promise<Server>((resolve, reject) => {
      const candidate = app.listen(port, host);
      candidate.once("listening", () => resolve(candidate));
      candidate.once("error", reject);
    });
    server.once("close", () => sessionStore.close());
    const address = server.address() as AddressInfo;
    return { server, url: `http://${formatHost(host)}:${address.port}`, authToken };
  } catch (error) {
    sessionStore.close();
    throw error;
  }
}

function isLoopbackHost(host: string) {
  return host === "127.0.0.1" || host === "::1" || host.toLowerCase() === "localhost";
}

function parsePort(value: string | undefined): number {
  if (!value) return 4173;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("WINGDIFF_PORT must be an integer between 0 and 65535.");
  }
  return port;
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
