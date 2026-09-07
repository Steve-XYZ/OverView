/**
 * The GitHub sign-in route. GitHub is contacted through an injected fetch, so the
 * flow — state, code exchange, profile read, account creation — is exercised without
 * a network call.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { FetchLike } from "../src/hosted/github.ts";
import { handleAuthCallback, handleAuthStart, handleLogout } from "../src/hosted/routes.ts";
import type { OauthDeps } from "../src/hosted/routes.ts";
import { cookieHeader, memoryStore, type MemoryStore } from "./helpers/hostedStore.ts";

const SESSION_SECRET = "session-secret-that-is-at-least-thirty-two-characters";
const CLIENT_ID = "Iv1.0123456789abcdef";
const CLIENT_SECRET = "github-client-secret-value";
const ACCESS_TOKEN = "gho_an_access_token_that_must_never_be_stored";
const START_URL = "https://overview.example/api/auth/github/start";

describe("GitHub sign-in", () => {
  it("asks GitHub for identity only and pins the reply to a single-use state cookie", () => {
    const response = handleAuthStart(new Request(START_URL), CLIENT_ID);
    assert.equal(response.status, 303);

    const location = new URL(response.headers.get("location") ?? "");
    assert.equal(location.origin + location.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(location.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(location.searchParams.get("scope"), "");
    assert.equal(
      location.searchParams.get("redirect_uri"),
      "https://overview.example/api/auth/github/callback",
    );

    const state = location.searchParams.get("state") ?? "";
    assert.match(state, /^[a-f0-9]{32}$/);
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.equal(cookieHeader(setCookie), `overview_oauth_state=${state}`);
  });

  it("creates the account on a valid callback and never stores the GitHub access token", async () => {
    const store = memoryStore();
    const calls: string[] = [];
    const response = await signIn(store, { id: 4242, login: "grace" }, calls);

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");

    const cookies = response.headers.getSetCookie();
    const session = cookies.find((cookie) => cookie.startsWith("overview_session="));
    assert.notEqual(session, undefined);
    assert.match(session ?? "", /HttpOnly/);
    // The state cookie is spent whether or not sign-in succeeded.
    assert.equal(cookies.some((cookie) => /^overview_oauth_state=;/.test(cookie)), true);

    assert.deepEqual(calls, [
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
    ]);
    const persisted = store.serialized();
    assert.equal(persisted.includes("grace"), true);
    assert.equal(persisted.includes(ACCESS_TOKEN), false);
    assert.equal(persisted.includes(CLIENT_SECRET), false);
  });

  it("refuses a callback whose state does not match the cookie and creates no account", async () => {
    const store = memoryStore();
    const response = await handleAuthCallback(
      new Request("https://overview.example/api/auth/github/callback?code=abc&state=attacker", {
        headers: { cookie: "overview_oauth_state=the-real-state" },
      }),
      deps(store, githubFetch({ id: 1, login: "ada" })),
    );

    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /\/login\?error=state$/);
    assert.equal(store.serialized().includes("ada"), false);
  });

  it("refuses a login outside the allow list and creates no account", async () => {
    const store = memoryStore();
    const response = await signIn(store, { id: 9, login: "mallory" }, [], { allowedLogins: "ada,grace" });

    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /\/login\?error=not_allowed$/);
    assert.equal(response.headers.getSetCookie().some((c) => c.startsWith("overview_session=")), false);
    assert.equal(store.serialized().includes("mallory"), false);
  });

  it("returns a second sign-in to the same account and follows a renamed login", async () => {
    const store = memoryStore();
    await signIn(store, { id: 4242, login: "grace" });
    await signIn(store, { id: 4242, login: "grace-hopper" });

    const users = (JSON.parse(store.serialized()) as { users: { githubLogin: string }[] }).users;
    assert.equal(users.length, 1);
    assert.equal(users[0]?.githubLogin, "grace-hopper");
  });

  it("reports a GitHub failure as a sign-in error rather than an account", async () => {
    const store = memoryStore();
    const failing: FetchLike = () => Promise.resolve(new Response("nope", { status: 500 }));
    const response = await signIn(store, { id: 1, login: "ada" }, [], { fetchImpl: failing });

    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /\/login\?error=github$/);
    assert.equal(store.serialized().includes("ada"), false);
  });

  it("clears the session cookie on sign out", () => {
    const response = handleLogout(new Request("https://overview.example/api/logout", { method: "POST" }));
    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /\/login$/);
    assert.match(response.headers.get("set-cookie") ?? "", /overview_session=;.*Max-Age=0/);
  });
});

function deps(store: MemoryStore, fetchImpl: FetchLike, allowedLogins?: string): OauthDeps {
  return {
    store,
    sessionSecret: SESSION_SECRET,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    allowedLogins,
    fetchImpl,
  };
}

/** Drives start then callback, so the state cookie is the one the route issued. */
async function signIn(
  store: MemoryStore,
  profile: { id: number; login: string },
  calls: string[] = [],
  options: { allowedLogins?: string; fetchImpl?: FetchLike } = {},
): Promise<Response> {
  const start = handleAuthStart(new Request(START_URL), CLIENT_ID);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const request = new Request(
    `https://overview.example/api/auth/github/callback?code=exchange-code&state=${state}`,
    { headers: { cookie: cookieHeader(start.headers.get("set-cookie") ?? "") } },
  );
  return handleAuthCallback(
    request,
    deps(store, options.fetchImpl ?? githubFetch(profile, calls), options.allowedLogins),
  );
}

function githubFetch(profile: { id: number; login: string }, calls: string[] = []): FetchLike {
  return (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://github.com/login/oauth/access_token") {
      return Promise.resolve(Response.json({ access_token: ACCESS_TOKEN, token_type: "bearer", scope: "" }));
    }
    if (url === "https://api.github.com/user") {
      return Promise.resolve(Response.json({ id: profile.id, login: profile.login, name: "Test User" }));
    }
    return Promise.resolve(new Response("unexpected", { status: 404 }));
  };
}
