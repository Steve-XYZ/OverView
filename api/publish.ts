import { neonStore } from "../src/hosted/neonStore.ts";
import { handlePublish, json } from "../src/hosted/routes.ts";

export async function PUT(request: Request): Promise<Response> {
  try {
    return await handlePublish(request, { store: neonStore() });
  } catch {
    return json(500, { error: "The hosted application could not store the publication." });
  }
}

export function GET(): Response {
  return json(405, { error: "Use PUT." }, { Allow: "PUT" });
}
