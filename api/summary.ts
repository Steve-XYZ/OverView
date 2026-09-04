import {
  hasValidSession,
  requiredSecret,
  SESSION_SECRET_ENV,
} from "../src/hosted/auth.ts";
import { readPublication } from "../src/hosted/database.ts";

const HOSTED_WINDOWS = new Set([7, 30, 90]);

export async function GET(request: Request): Promise<Response> {
  try {
    const sessionSecret = requiredSecret(SESSION_SECRET_ENV);
    if (!(await hasValidSession(request, sessionSecret))) {
      return json(401, { error: "Authentication required." });
    }
    const requested = Number(new URL(request.url).searchParams.get("days") ?? 30);
    const days = HOSTED_WINDOWS.has(requested) ? requested : 30;
    const current = await readPublication();
    if (current === null) return json(404, { error: "Nothing has been published yet." });
    const summary = current.publication.snapshots[String(days) as "7" | "30" | "90"];
    return json(200, { ...summary, publishedAt: current.publishedAt });
  } catch {
    return json(500, { error: "The hosted application could not read the dashboard." });
  }
}

export function POST(): Response {
  return json(405, { error: "Only GET is supported." }, { Allow: "GET" });
}

function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...Object.fromEntries(new Headers(headers)) },
  });
}
