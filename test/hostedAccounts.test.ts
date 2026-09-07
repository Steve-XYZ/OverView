/**
 * Account isolation: the property the hosted mirror exists to keep once more than one
 * developer uses it. Every test here asks whether one account can observe or disturb
 * another's data through a route that is otherwise working correctly.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createSessionCookie } from "../src/hosted/auth.ts";
import { handlePublish, handleSummary, handleTokens } from "../src/hosted/routes.ts";
import type { SessionDeps } from "../src/hosted/routes.ts";
import { defaultConfig } from "../src/config/config.ts";
import { buildPublication, type PublicationEnvelope } from "../src/publish/publish.ts";
import { commit, IDENTITY, seedDatabase, writeAll } from "./helpers/seed.ts";
import { cookieHeader, memoryStore, type MemoryStore } from "./helpers/hostedStore.ts";

const NOW = Date.parse("2026-09-03T18:00:00Z");
const SESSION_SECRET = "session-secret-that-is-at-least-thirty-two-characters";
const TOKENS_URL = "https://overview.example/api/tokens";
const PUBLISH_URL = "https://overview.example/api/publish";
const SUMMARY_URL = "https://overview.example/api/summary?days=30";

interface Account {
  readonly userId: string;
  readonly login: string;
  readonly cookie: string;
  readonly token: string;
  readonly tokenId: string;
}

describe("hosted account isolation", () => {
  it("gives two accounts that publish different snapshots only their own dashboard", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const grace = await onboard(store, 2, "grace");

    const adaPublication = publicationOf(["ada-1", "ada-2", "ada-3"]);
    const gracePublication = publicationOf(["grace-1"]);
    assert.notEqual(adaPublication.publicationId, gracePublication.publicationId);

    assert.equal((await publish(store, ada.token, adaPublication)).status, 200);
    assert.equal((await publish(store, grace.token, gracePublication)).status, 200);

    const adaSummary = await readSummary(store, ada.cookie);
    const graceSummary = await readSummary(store, grace.cookie);

    assert.equal(adaSummary.status, 200);
    assert.equal(graceSummary.status, 200);
    assert.equal(adaSummary.body.totals.commitsAuthored, 3);
    assert.equal(graceSummary.body.totals.commitsAuthored, 1);
    assert.equal(adaSummary.body.account.githubLogin, "ada");
    assert.equal(graceSummary.body.account.githubLogin, "grace");
  });

  it("keeps one account's publication out of the other's row", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const grace = await onboard(store, 2, "grace");

    await publish(store, ada.token, publicationOf(["ada-1", "ada-2"]));
    const before = await readSummary(store, ada.cookie);

    // Grace publishes a different payload with her own token.
    await publish(store, grace.token, publicationOf(["grace-1", "grace-2", "grace-3", "grace-4"]));

    const after = await readSummary(store, ada.cookie);
    assert.equal(after.body.totals.commitsAuthored, 2);
    assert.equal(after.body.publishedAt, before.body.publishedAt);
    assert.equal((await readSummary(store, grace.cookie)).body.totals.commitsAuthored, 4);
  });

  it("shows a new account nothing rather than another account's data", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    await publish(store, ada.token, publicationOf(["ada-1"]));

    const grace = await onboard(store, 2, "grace");
    const response = await handleSummary(request(SUMMARY_URL, { cookie: grace.cookie }), deps(store));
    assert.equal(response.status, 404);
  });

  it("refuses a revoked token and leaves the snapshot it published in place", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    await publish(store, ada.token, publicationOf(["ada-1"]));

    const revoked = await handleTokens(
      request(`${TOKENS_URL}?id=${ada.tokenId}`, { cookie: ada.cookie }, "DELETE"),
      deps(store),
    );
    assert.equal(revoked.status, 200);

    const rejected = await publish(store, ada.token, publicationOf(["ada-1", "ada-2"]));
    assert.equal(rejected.status, 401);

    const summary = await readSummary(store, ada.cookie);
    assert.equal(summary.body.totals.commitsAuthored, 1);
  });

  it("refuses to revoke or list a token owned by another account", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const grace = await onboard(store, 2, "grace");

    const stolen = await handleTokens(
      request(`${TOKENS_URL}?id=${ada.tokenId}`, { cookie: grace.cookie }, "DELETE"),
      deps(store),
    );
    assert.equal(stolen.status, 404);

    const listed = await handleTokens(request(TOKENS_URL, { cookie: grace.cookie }), deps(store));
    const body = (await listed.json()) as { githubLogin: string; tokens: { id: string }[] };
    assert.equal(body.githubLogin, "grace");
    assert.deepEqual(body.tokens.map((token) => token.id), [grace.tokenId]);

    // Ada's token still works, so the refusal was a refusal and not a silent delete.
    assert.equal((await publish(store, ada.token, publicationOf(["ada-1"]))).status, 200);
  });

  it("keeps the two credential kinds from standing in for each other", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const publication = publicationOf(["ada-1"]);

    const cookiePublish = await handlePublish(
      new Request(PUBLISH_URL, {
        method: "PUT",
        headers: { cookie: ada.cookie, "content-type": "application/json" },
        body: JSON.stringify(publication),
      }),
      { store },
    );
    assert.equal(cookiePublish.status, 401);

    const tokenRead = await handleSummary(
      new Request(SUMMARY_URL, { headers: { authorization: `Bearer ${ada.token}` } }),
      deps(store),
    );
    assert.equal(tokenRead.status, 401);

    const tokenTokens = await handleTokens(
      new Request(TOKENS_URL, { headers: { authorization: `Bearer ${ada.token}` } }),
      deps(store),
    );
    assert.equal(tokenTokens.status, 401);
  });

  it("rejects a session cookie edited to name another account", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const grace = await onboard(store, 2, "grace");
    await publish(store, grace.token, publicationOf(["grace-1"]));

    const forged = ada.cookie.replace(ada.userId, grace.userId);
    assert.notEqual(forged, ada.cookie);

    const response = await handleSummary(request(SUMMARY_URL, { cookie: forged }), deps(store));
    assert.equal(response.status, 401);
  });

  it("rejects a validly signed cookie for an account that no longer exists", async () => {
    const store = memoryStore();
    const cookie = cookieHeader(await createSessionCookie(crypto.randomUUID(), SESSION_SECRET));
    const response = await handleSummary(request(SUMMARY_URL, { cookie }), deps(store));
    assert.equal(response.status, 401);
  });

  it("never stores a collector token in a form that can be replayed", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    assert.match(ada.token, /^ovp_[A-Za-z0-9_-]{43}$/);
    assert.equal(store.serialized().includes(ada.token), false);
  });
});

function deps(store: MemoryStore): SessionDeps {
  return { store, sessionSecret: SESSION_SECRET };
}

/** Runs the real sign-in-to-token path so the tests use credentials the routes issued. */
async function onboard(store: MemoryStore, githubId: number, login: string): Promise<Account> {
  const user = await store.upsertUser(githubId, login);
  const cookie = cookieHeader(await createSessionCookie(user.id, SESSION_SECRET));
  const created = await handleTokens(
    new Request(TOKENS_URL, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: `${login}-laptop` }),
    }),
    deps(store),
  );
  assert.equal(created.status, 201);
  const body = (await created.json()) as { token: string; record: { id: string } };
  return { userId: user.id, login, cookie, token: body.token, tokenId: body.record.id };
}

function publish(
  store: MemoryStore,
  token: string,
  publication: PublicationEnvelope,
): Promise<Response> {
  return handlePublish(
    new Request(PUBLISH_URL, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(publication),
    }),
    { store },
  );
}

async function readSummary(
  store: MemoryStore,
  cookie: string,
): Promise<{ status: number; body: { totals: { commitsAuthored: number }; publishedAt: string; account: { githubLogin: string } } }> {
  const response = await handleSummary(request(SUMMARY_URL, { cookie }), deps(store));
  return {
    status: response.status,
    body: (await response.json()) as {
      totals: { commitsAuthored: number };
      publishedAt: string;
      account: { githubLogin: string };
    },
  };
}

function request(url: string, headers: Record<string, string>, method = "GET"): Request {
  return new Request(url, { method, headers });
}

/** A real publication built by the local pipeline, so the envelope check is genuine. */
function publicationOf(shas: readonly string[]): PublicationEnvelope {
  const seeded = seedDatabase();
  writeAll(seeded, {
    commits: shas.map((sha) =>
      commit({ sha, authoredAt: "2026-09-02T10:00:00Z", syncRunId: seeded.syncRunId })
    ),
  });
  try {
    return buildPublication(
      seeded.db,
      {
        ...defaultConfig(),
        identity: IDENTITY,
        repositories: [{ path: "/src/widget", githubRepo: "acme/widget" }],
      },
      NOW,
    );
  } finally {
    seeded.db.close();
  }
}
