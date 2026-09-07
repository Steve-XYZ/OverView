/**
 * GitHub as an identity provider and nothing else.
 *
 * The authorize request asks for no scopes, so consent grants read of the public
 * profile and no repository access at all. The access token returned by the exchange
 * is used once, in memory, to read `/user`, and is never written to the database,
 * a cookie, or a log. Collection still happens locally through the developer's own
 * `gh` credentials; the cloud never holds a GitHub credential that could reach code.
 */

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const USER_AGENT = "overview-hosted/1";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GithubIdentity {
  readonly id: number;
  readonly login: string;
}

export interface ExchangeInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  // Explicitly empty: identity only. Anything here would be a repository grant.
  url.searchParams.set("scope", "");
  return url.toString();
}

export async function exchangeCodeForIdentity(
  input: ExchangeInput,
  fetchImpl: FetchLike = fetch,
): Promise<GithubIdentity> {
  const tokenResponse = await fetchImpl(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tokenResponse.ok) throw new Error(`GitHub rejected the code exchange (HTTP ${tokenResponse.status}).`);

  const payload: unknown = await tokenResponse.json().catch(() => null);
  if (!isRecord(payload)) throw new Error("GitHub returned an unreadable token response.");
  if (typeof payload["error"] === "string") {
    throw new Error(`GitHub rejected the code exchange: ${payload["error"]}.`);
  }
  const accessToken = payload["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("GitHub returned no access token.");
  }

  const userResponse = await fetchImpl(USER_URL, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!userResponse.ok) throw new Error(`GitHub refused the profile read (HTTP ${userResponse.status}).`);

  const profile: unknown = await userResponse.json().catch(() => null);
  if (!isRecord(profile)) throw new Error("GitHub returned an unreadable profile.");
  const id = profile["id"];
  const login = profile["login"];
  if (typeof id !== "number" || !Number.isInteger(id) || typeof login !== "string" || login.length === 0) {
    throw new Error("GitHub returned a profile without a usable id and login.");
  }
  return { id, login };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
