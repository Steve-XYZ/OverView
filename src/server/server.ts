/**
 * The local dashboard server.
 *
 * Binds to the loopback interface and serves two things: a JSON summary and the
 * static page that renders it. There is no auth because there is no network
 * surface — moving this to a hosted dashboard means putting a real server in front
 * of `buildSummary`, not rewriting it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OverviewConfig } from "../config/config.ts";
import type { Db } from "../store/db.ts";
import { buildSummary } from "../metrics/summary.ts";
import { createWindow, parseWindowDays } from "../metrics/window.ts";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export interface ServeOptions {
  readonly port?: number;
  readonly host?: string;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Locate the compiled output directory.
 *
 * The static root is `dist`, not `dist/web`: the dashboard's entry module imports
 * compiled code from sibling directories (`dist/report/text.js`), so anything the
 * browser can reach through an import has to be reachable over HTTP too. The page
 * itself lives at `dist/web/index.html` and is served at `/`.
 */
export const INDEX_PATH = "web/index.html";
const ENTRY_PATH = "web/app.js";

export function resolveWebRoot(): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    resolve(here, ".."), // dist/server -> dist
    resolve(here, "../../dist"), // src/server -> dist
  ];
  // Probe for the compiled entry, not just the page: running from source, the
  // sibling `src/web` holds an index.html next to app.ts, which the browser cannot use.
  return (
    candidates.find(
      (candidate) =>
        existsSync(join(candidate, INDEX_PATH)) && existsSync(join(candidate, ENTRY_PATH)),
    ) ?? null
  );
}

export async function startServer(
  db: Db,
  config: OverviewConfig,
  options: ServeOptions = {},
): Promise<RunningServer> {
  const port = options.port ?? config.server.port;
  const host = options.host ?? config.server.host;
  const webRoot = resolveWebRoot();

  const server = createServer((request, response) => {
    handle(request, response, db, config, webRoot).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    url: `http://${host}:${boundPort}/`,
    port: boundPort,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  db: Db,
  config: OverviewConfig,
  webRoot: string | null,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Only GET is supported." });
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");

  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, webAssets: webRoot !== null });
    return;
  }

  if (url.pathname === "/api/summary") {
    const days = parseWindowDays(url.searchParams.get("days") ?? undefined);
    const summary = buildSummary(db, createWindow(days), config.identity);
    sendJson(response, 200, summary);
    return;
  }

  if (webRoot === null) {
    sendText(
      response,
      503,
      "The dashboard assets are not built yet. Run `npm run build`, then reload.",
    );
    return;
  }

  await sendStatic(response, webRoot, url.pathname);
}

async function sendStatic(
  response: ServerResponse,
  webRoot: string,
  pathname: string,
): Promise<void> {
  const relative = pathname === "/" ? INDEX_PATH : normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(webRoot, `.${relative.startsWith("/") ? relative : `/${relative}`}`);

  // Refuse anything that resolved outside the asset directory.
  if (!filePath.startsWith(resolve(webRoot))) {
    sendText(response, 403, "Forbidden");
    return;
  }
  if (!existsSync(filePath)) {
    sendText(response, 404, "Not found");
    return;
  }

  const body = await readFile(filePath);
  response.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}
