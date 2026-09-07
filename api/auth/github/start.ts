import { GITHUB_CLIENT_ID_ENV, requiredSecret } from "../../../src/hosted/auth.ts";
import { handleAuthStart } from "../../../src/hosted/routes.ts";

export function GET(request: Request): Response {
  try {
    return handleAuthStart(request, requiredSecret(GITHUB_CLIENT_ID_ENV));
  } catch {
    return Response.redirect(new URL("/login?error=configuration", request.url), 303);
  }
}
