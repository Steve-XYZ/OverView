/**
 * Hosted request handling. The `api/` files are wiring; the decisions live here so
 * they can be exercised against any `HostedStore`, including a fake.
 *
 * Every route derives its user from a credential it verifies itself — a session
 * cookie or a collector token — and then passes that user id to the store. No route
 * accepts a user id from the request.
 */

import {
  bearerToken,
  clearOauthStateCookie,
  clearSessionCookie,
  createOauthStateCookie,
  createSessionCookie,
  createCollectorToken,
  hashCollectorToken,
  loginAllowed,
  randomState,
  readOauthStateCookie,
  readSession,
  safeEqual,
} from "./auth.ts";
import { authorizeUrl, exchangeCodeForIdentity, type FetchLike } from "./github.ts";
import type { HostedStore, HostedUser } from "./store.ts";
import {
  isLedgerPublication,
  isPublicationEnvelope,
  MAX_PUBLICATION_BYTES,
  type WindowKey,
} from "../publish/publish.ts";
import { summarize } from "../metrics/summary.ts";
import { createWindow } from "../metrics/window.ts";

const MAX_TOKEN_NAME = 60;
const HOSTED_WINDOWS = new Set([7, 30, 90]);
const DEFAULT_TOKEN_NAME = "collector";

export interface SessionDeps {
  readonly store: HostedStore;
  readonly sessionSecret: string;
  readonly now?: number | undefined;
}

export interface OauthDeps extends SessionDeps {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly allowedLogins?: string | undefined;
  readonly fetchImpl?: FetchLike | undefined;
}

export interface PublishDeps {
  readonly store: HostedStore;
}

export function handleAuthStart(request: Request, clientId: string): Response {
  const state = randomState();
  return new Response(null, {
    status: 303,
    headers: {
      location: authorizeUrl(clientId, callbackUrl(request), state),
      "set-cookie": createOauthStateCookie(state),
      "cache-control": "no-store",
    },
  });
}

export async function handleAuthCallback(request: Request, deps: OauthDeps): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = readOauthStateCookie(request);

  // The state cookie is single-use whatever happens next.
  if (code === null || state === null || expectedState === null || !safeEqual(state, expectedState)) {
    return signInFailure(request, "state");
  }

  let identity: { readonly id: number; readonly login: string };
  try {
    identity = await exchangeCodeForIdentity(
      {
        clientId: deps.clientId,
        clientSecret: deps.clientSecret,
        code,
        redirectUri: callbackUrl(request),
      },
      deps.fetchImpl ?? fetch,
    );
  } catch {
    return signInFailure(request, "github");
  }

  if (!loginAllowed(identity.login, deps.allowedLogins)) return signInFailure(request, "not_allowed");

  const user = await deps.store.upsertUser(identity.id, identity.login);
  const headers = new Headers({ location: "/", "cache-control": "no-store" });
  headers.append("set-cookie", await createSessionCookie(user.id, deps.sessionSecret, deps.now ?? Date.now()));
  headers.append("set-cookie", clearOauthStateCookie());
  return new Response(null, { status: 303, headers });
}

export function handleLogout(request: Request): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL("/login", request.url).toString(),
      "set-cookie": clearSessionCookie(),
      "cache-control": "no-store",
    },
  });
}

/**
 * The dashboard read.
 *
 * The ledger answers when the account has published one: the window is built in the
 * collector's zone, the facts for that range are read, and the same `summarize` the
 * local report uses derives the numbers. An account that has only ever published
 * snapshots — or a request that explicitly asks for `source=snapshot`, which is how
 * the two paths get compared — reads the stored summary instead.
 */
export async function handleSummary(request: Request, deps: SessionDeps): Promise<Response> {
  const user = await currentUser(request, deps);
  if (user === null) return json(401, { error: "Authentication required." });

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("days") ?? 30);
  const days = HOSTED_WINDOWS.has(requested) ? requested : 30;
  const requestedSource = url.searchParams.get("source");
  if (requestedSource !== null && requestedSource !== "ledger" && requestedSource !== "snapshot") {
    return json(400, { error: "source must be ledger or snapshot." });
  }
  const account = { githubLogin: user.githubLogin };

  if (requestedSource !== "snapshot") {
    const ledger = await deps.store.getLedgerHead(user.id);
    if (ledger !== null) {
      const window = createWindow(days, deps.now ?? Date.now(), ledger.collector.timeZone);
      const records = await deps.store.readLedgerRecords(user.id, {
        fromMs: window.fromMs,
        toMs: window.toMs,
        fromDay: window.startDayKey,
        toDay: window.endDayKey,
      });
      return json(200, {
        ...summarize({ collector: ledger.collector, ...records }, window),
        publishedAt: ledger.publishedAt,
        account,
        source: "ledger",
      });
    }
    if (requestedSource === "ledger") {
      return json(404, { error: "No normalized facts have been published yet." });
    }
  }

  const current = await deps.store.getSnapshot(user.id);
  if (current === null) return json(404, { error: "Nothing has been published yet." });
  return json(200, {
    ...current.snapshots[String(days) as WindowKey],
    publishedAt: current.publishedAt,
    account,
    source: "snapshot",
  });
}

export async function handleTokens(request: Request, deps: SessionDeps): Promise<Response> {
  const user = await currentUser(request, deps);
  if (user === null) return json(401, { error: "Authentication required." });

  if (request.method === "GET") {
    return json(200, { githubLogin: user.githubLogin, tokens: await deps.store.listTokens(user.id) });
  }

  if (request.method === "POST") {
    const name = await requestedTokenName(request);
    if (name === null) return json(400, { error: `A token name must be 1 to ${MAX_TOKEN_NAME} characters.` });
    const created = await createCollectorToken();
    const record = await deps.store.createToken(user.id, name, created.hash, created.prefix);
    // The only response that will ever contain the plaintext.
    return json(201, { token: created.token, record });
  }

  if (request.method === "DELETE") {
    const id = new URL(request.url).searchParams.get("id");
    if (id === null || id.length === 0) return json(400, { error: "A token id is required." });
    const deleted = await deps.store.deleteToken(user.id, id);
    return deleted ? json(200, { deleted: true }) : json(404, { error: "No such token." });
  }

  return json(405, { error: "Use GET, POST or DELETE." }, { Allow: "GET, POST, DELETE" });
}

export async function handlePublish(request: Request, deps: PublishDeps): Promise<Response> {
  const presented = bearerToken(request);
  if (presented === null) return json(401, { error: "Unauthorized." });
  // The credential identifies both the account and which collector is publishing;
  // authority to remove a stored fact is scoped to the latter.
  const collector = await deps.store.findCollectorByTokenHash(await hashCollectorToken(presented));
  if (collector === null) return json(401, { error: "Unauthorized." });
  const user = collector.user;

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
  // Version 2 carries normalized facts and the snapshots derived from them; version 1
  // is snapshots alone, and is still accepted so an older collector keeps working.
  if (isLedgerPublication(body)) {
    return json(200, await deps.store.putLedger(user.id, collector.collectorId, body));
  }
  if (isPublicationEnvelope(body)) return json(200, await deps.store.putSnapshot(user.id, body));
  return json(400, { error: "Publication does not match schema version 1 or 2." });
}

/**
 * A cookie that survives verification still has to name an account that exists, so a
 * deleted user cannot keep reading with a signature that remains valid.
 */
async function currentUser(request: Request, deps: SessionDeps): Promise<HostedUser | null> {
  const session = await readSession(request, deps.sessionSecret, deps.now ?? Date.now());
  if (session === null) return null;
  return deps.store.findUser(session.userId);
}

async function requestedTokenName(request: Request): Promise<string | null> {
  const raw = await request.text();
  if (raw.trim().length === 0) return DEFAULT_TOKEN_NAME;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const supplied = (body as Record<string, unknown>)["name"];
  if (supplied === undefined || supplied === null) return DEFAULT_TOKEN_NAME;
  if (typeof supplied !== "string") return null;
  const name = supplied.trim();
  if (name.length === 0) return DEFAULT_TOKEN_NAME;
  return name.length > MAX_TOKEN_NAME ? null : name;
}

function callbackUrl(request: Request): string {
  return new URL("/api/auth/github/callback", request.url).toString();
}

function signInFailure(request: Request, reason: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL(`/login?error=${reason}`, request.url).toString(),
      "set-cookie": clearOauthStateCookie(),
      "cache-control": "no-store",
    },
  });
}

export function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...Object.fromEntries(new Headers(headers)) },
  });
}
