import {
  HOSTED_PUBLISH_TOKEN_ENV,
  requiredSecret,
  validPublishAuthorization,
} from "../src/hosted/auth.ts";
import { storePublication } from "../src/hosted/database.ts";
import { isPublicationEnvelope } from "../src/publish/publish.ts";

const MAX_PUBLICATION_BYTES = 1_500_000;

export async function PUT(request: Request): Promise<Response> {
  try {
    const token = requiredSecret(HOSTED_PUBLISH_TOKEN_ENV);
    if (!(await validPublishAuthorization(request, token))) return json(401, { error: "Unauthorized." });

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_PUBLICATION_BYTES) return json(413, { error: "Publication is too large." });
    const raw = await request.text();
    if (Buffer.byteLength(raw) > MAX_PUBLICATION_BYTES) {
      return json(413, { error: "Publication is too large." });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "Publication must be valid JSON." });
    }
    if (!isPublicationEnvelope(body)) {
      return json(400, { error: "Publication does not match schema version 1." });
    }
    return json(200, await storePublication(body));
  } catch {
    return json(500, { error: "The hosted application could not store the publication." });
  }
}

export function GET(): Response {
  return json(405, { error: "Use PUT." }, { Allow: "PUT" });
}

function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...Object.fromEntries(new Headers(headers)) },
  });
}
