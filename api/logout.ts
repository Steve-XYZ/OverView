import { handleLogout } from "../src/hosted/routes.ts";

export function POST(request: Request): Response {
  return handleLogout(request);
}

export function GET(request: Request): Response {
  return Response.redirect(new URL("/", request.url), 303);
}
