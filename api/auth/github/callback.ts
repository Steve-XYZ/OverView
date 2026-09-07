import {
  ALLOWED_LOGINS_ENV,
  GITHUB_CLIENT_ID_ENV,
  GITHUB_CLIENT_SECRET_ENV,
  requiredSecret,
  SESSION_SECRET_ENV,
} from "../../../src/hosted/auth.ts";
import { neonStore } from "../../../src/hosted/neonStore.ts";
import { handleAuthCallback } from "../../../src/hosted/routes.ts";

export async function GET(request: Request): Promise<Response> {
  try {
    return await handleAuthCallback(request, {
      store: neonStore(),
      sessionSecret: requiredSecret(SESSION_SECRET_ENV),
      clientId: requiredSecret(GITHUB_CLIENT_ID_ENV),
      clientSecret: requiredSecret(GITHUB_CLIENT_SECRET_ENV),
      allowedLogins: process.env[ALLOWED_LOGINS_ENV],
    });
  } catch {
    return Response.redirect(new URL("/login?error=configuration", request.url), 303);
  }
}
