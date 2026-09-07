import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  bearerToken,
  createCollectorToken,
  createSessionCookie,
  hashCollectorToken,
  loginAllowed,
  readSession,
} from "../src/hosted/auth.ts";
import { cookieHeader } from "./helpers/hostedStore.ts";

const NOW = Date.parse("2026-09-03T18:00:00Z");
const SECRET = "session-secret-that-is-long-and-random-enough";
const USER = "6f1c9d5e-0f2a-4c7b-9c5e-2f7a8b1d3e4f";
const OTHER_USER = "0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

describe("hosted sessions", () => {
  it("names one account in a secure HttpOnly cookie and verifies it until expiry", async () => {
    const cookie = await createSessionCookie(USER, SECRET, NOW);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);

    const request = new Request("https://overview.example/", { headers: { cookie: cookieHeader(cookie) } });
    assert.deepEqual(await readSession(request, SECRET, NOW + 1_000), { userId: USER });
    assert.equal(await readSession(request, SECRET, NOW + 31 * 24 * 60 * 60 * 1_000), null);
    assert.equal(await readSession(request, `${SECRET}x`, NOW + 1_000), null);
  });

  it("refuses a cookie whose user id was swapped for another account's", async () => {
    const cookie = cookieHeader(await createSessionCookie(USER, SECRET, NOW));
    const forged = cookie.replace(USER, OTHER_USER);
    assert.notEqual(forged, cookie);

    const request = new Request("https://overview.example/", { headers: { cookie: forged } });
    assert.equal(await readSession(request, SECRET, NOW + 1_000), null);
  });

  it("refuses a session that carries no account at all", async () => {
    const request = new Request("https://overview.example/", {
      headers: { cookie: `overview_session=v2..${Math.floor(NOW / 1000) + 600}.signature` },
    });
    assert.equal(await readSession(request, SECRET, NOW), null);
  });
});

describe("collector tokens", () => {
  it("issues a high-entropy token and keeps only a deterministic digest of it", async () => {
    const first = await createCollectorToken();
    const second = await createCollectorToken();

    assert.match(first.token, /^ovp_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.token, second.token);
    assert.notEqual(first.hash, second.hash);
    assert.equal(first.hash.includes(first.token), false);
    assert.match(first.hash, /^[a-f0-9]{64}$/);
    assert.equal(await hashCollectorToken(first.token), first.hash);
    assert.notEqual(await hashCollectorToken(second.token), first.hash);
    assert.equal(first.prefix, first.token.slice(0, 10));
  });

  it("reads a bearer token only from a bearer header", async () => {
    const value = (await createCollectorToken()).token;
    assert.equal(
      bearerToken(new Request("https://overview.example/", { headers: { authorization: `Bearer ${value}` } })),
      value,
    );
    assert.equal(
      bearerToken(new Request("https://overview.example/", { headers: { authorization: value } })),
      null,
    );
    assert.equal(
      bearerToken(new Request("https://overview.example/", { headers: { cookie: `overview_session=${value}` } })),
      null,
    );
  });
});

describe("the sign-in allow list", () => {
  it("is open when unset and restrictive when set", () => {
    assert.equal(loginAllowed("ada", undefined), true);
    assert.equal(loginAllowed("ada", "   "), true);
    assert.equal(loginAllowed("ada", "ada,grace"), true);
    assert.equal(loginAllowed("ADA", " ada , grace "), true);
    assert.equal(loginAllowed("mallory", "ada,grace"), false);
  });
});
