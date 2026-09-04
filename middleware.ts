import { next } from "@vercel/functions";
import { hasValidSession, requiredSecret, SESSION_SECRET_ENV } from "./src/hosted/auth.ts";

export const config = {
  matcher: ["/", "/web/:path*", "/report/:path*", "/domain/:path*", "/api/summary"],
};

export default async function middleware(request: Request): Promise<Response> {
  let authenticated = false;
  try {
    authenticated = await hasValidSession(request, requiredSecret(SESSION_SECRET_ENV));
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
