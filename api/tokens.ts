import { requiredSecret, SESSION_SECRET_ENV } from "../src/hosted/auth.ts";
import { neonStore } from "../src/hosted/neonStore.ts";
import { handleTokens, json } from "../src/hosted/routes.ts";

async function route(request: Request): Promise<Response> {
  try {
    return await handleTokens(request, {
      store: neonStore(),
      sessionSecret: requiredSecret(SESSION_SECRET_ENV),
    });
  } catch {
    return json(500, { error: "The hosted application could not manage collector tokens." });
  }
}

export const GET = route;
export const POST = route;
export const DELETE = route;
