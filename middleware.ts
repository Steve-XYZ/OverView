import { next } from "@vercel/functions";
import { readSession, requiredSecret, SESSION_SECRET_ENV } from "./src/hosted/auth.ts";

export const config = {
  matcher: [
    "/",
    "/account",
    "/web/:path*",
    "/report/:path*",
    "/domain/:path*",
    "/api/summary",
    "/api/tokens",
  ],
};

export default async function middleware(request: Request): Promise<Response> {
  let authenticated = false;
  try {
    authenticated = (await readSession(request, requiredSecret(SESSION_SECRET_ENV))) !== null;
  } catch {
    authenticated = false;
  }
  if (authenticated) return next();

  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    return Response.json({ error: "Authentication required." }, {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  }
  return Response.redirect(new URL("/login", request.url), 303);
}
