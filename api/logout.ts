import { clearSessionCookie } from "../src/hosted/auth.ts";

export function POST(request: Request): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL("/login", request.url).toString(),
      "set-cookie": clearSessionCookie(),
      "cache-control": "no-store",
    },
  });
}

export function GET(request: Request): Response {
  return Response.redirect(new URL("/", request.url), 303);
}
