import { requiredSecret, SESSION_SECRET_ENV } from "../src/hosted/auth.ts";
import { neonStore } from "../src/hosted/neonStore.ts";
import { handleSummary, json } from "../src/hosted/routes.ts";

export async function GET(request: Request): Promise<Response> {
  try {
    return await handleSummary(request, {
      store: neonStore(),
      sessionSecret: requiredSecret(SESSION_SECRET_ENV),
    });
  } catch {
    return json(500, { error: "The hosted application could not read the dashboard." });
  }
}

export function POST(): Response {
  return json(405, { error: "Only GET is supported." }, { Allow: "GET" });
}
