import { strict as assert } from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";
import type { LedgerFacts } from "../src/domain/facts.ts";
import { createSessionCookie } from "../src/hosted/auth.ts";
import { handleSummary } from "../src/hosted/routes.ts";
import type { HostedUser } from "../src/hosted/store.ts";
import type { ActivitySummary } from "../src/metrics/summary.ts";
import { buildLedgerPublication, type LedgerPublication } from "../src/publish/publish.ts";
import { LEDGER_CONFIG, NOW, SECRETS, seedLedgerDatabase } from "./helpers/ledgerFixture.ts";
import { cookieHeader } from "./helpers/hostedStore.ts";
import { postgresStore } from "./helpers/postgres.ts";

const url = process.env["OVERVIEW_TEST_DATABASE_URL"];
const secret = "postgres-test-session-secret-at-least-32-characters";

describe("production SQL on PostgreSQL", { skip: url === undefined, timeout: 120_000 }, () => {
  const database = postgresStore(url ?? "", `overview_test_${crypto.randomUUID().replaceAll("-", "")}`);
  const store = database.store;
  let ada: HostedUser;
  let grace: HostedUser;
  let publication: LedgerPublication;

  before(async () => {
    await database.create();
    const seeded = seedLedgerDatabase();
    try { publication = buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW); }
    finally { seeded.db.close(); }
  });
  after(async () => { await database.drop(); });
  beforeEach(async () => {
    // Cascades exercise the real foreign keys and keep each test independent.
    ada = await store.upsertUser(1, "ada");
    await database.execute("DELETE FROM overview_user");
    ada = await store.upsertUser(1, "ada");
    grace = await store.upsertUser(2, "grace");
  });

  it("round-trips accounts and tokens without crossing account boundaries", async () => {
    assert.equal((await store.upsertUser(1, "ada-renamed")).id, ada.id);
    assert.equal((await store.findUser(ada.id))?.githubLogin, "ada-renamed");
    assert.equal(await store.findUser("missing"), null);
    const token = await store.createToken(ada.id, "Laptop, 'quoted'\n\\backslash", "hash-ada", "ovp_ada");
    assert.equal(token.lastUsedAt, null);
    assert.deepEqual(await store.listTokens(grace.id), []);
    assert.equal(await store.deleteToken(grace.id, token.id), false);
    assert.equal(await store.findCollectorByTokenHash("missing"), null);
    assert.equal((await store.findCollectorByTokenHash("hash-ada"))?.collectorId, token.id);
    const [used] = await store.listTokens(ada.id);
    assert.equal(used?.name, token.name);
    assert.ok(used?.lastUsedAt);
    assert.equal(await store.deleteToken(ada.id, token.id), true);
    assert.equal(await store.findCollectorByTokenHash("hash-ada"), null);
  });

  it("reconciles all 7/30/90-day SQL-backed responses with the local oracle", async () => {
    await store.putLedger(ada.id, "laptop", publication);
    const cookie = cookieHeader(await createSessionCookie(ada.id, secret, NOW));
    for (const days of ["7", "30", "90"] as const) {
      const response = await handleSummary(new Request(`https://overview.example/api/summary?days=${days}`, {
        headers: { cookie },
      }), { store, sessionSecret: secret, now: NOW });
      assert.equal(response.status, 200);
      const summary = await response.json() as ActivitySummary;
      const { generatedAt: _generatedAt, publishedAt: _publishedAt, account: _account, source: _source, ...actual } = summary;
      const { generatedAt: _expectedAt, publishedAt: _expectedPublished, account: _expectedAccount, source: _expectedSource, ...expected } = publication.snapshots[days];
      assert.deepEqual(actual, expected, `${days}-day SQL summary differs`);
      for (const value of SECRETS) assert.equal(JSON.stringify(summary).includes(value), false);
    }
    assert.equal(await store.getLedgerHead(grace.id), null);
    assert.equal(await store.getSnapshot(grace.id), null);
    assert.ok(Object.values(await records(grace.id)).every((value) => value.length === 0));
  });

  it("keeps publication timestamps steady on repeated ledger and snapshot writes", async () => {
    const first = await store.putLedger(ada.id, "laptop", publication);
    assert.equal(first.alreadyCurrent, false);
    assert.deepEqual(await store.putLedger(ada.id, "laptop", publication), { ...first, alreadyCurrent: true });
    const snapshot = { schemaVersion: 1 as const, publicationId: "snapshot-one", snapshots: publication.snapshots };
    const saved = await store.putSnapshot(grace.id, snapshot);
    assert.deepEqual(await store.putSnapshot(grace.id, snapshot), { ...saved, alreadyCurrent: true });
    assert.deepEqual((await store.getSnapshot(grace.id))?.snapshots, publication.snapshots);
  });

  it("corrects records inside coverage and retains older history", async () => {
    const [commit] = publication.facts.commits;
    assert.ok(commit);
    const old = { ...commit, sha: "old-history", authoredAtMs: publication.coverage.fromMs - 1 };
    await store.putLedger(ada.id, "laptop", changed({ ...publication.facts, commits: [...publication.facts.commits, old] }));
    await store.putLedger(ada.id, "laptop", changed({
      ...publication.facts, repositoryDays: [], commits: [], pullRequests: [], reviews: [], linearIssues: [],
      pullRequestLinks: [], commitLinks: [],
    }));
    const remaining = await records(ada.id);
    assert.deepEqual(remaining.commits.map((entry) => entry.sha), ["old-history"]);
    for (const key of ["repositoryDays", "pullRequests", "reviews", "linearIssues", "pullRequestLinks", "commitLinks"] as const) {
      assert.deepEqual(remaining[key], [], `${key} was not reconciled`);
    }
  });

  it("preserves another collector's facts when a shared repository is dropped", async () => {
    await store.putLedger(ada.id, "desktop", publication);
    const [first] = publication.facts.commits;
    assert.ok(first);
    // Laptop claims one of desktop's records, then drops all its repositories.
    await store.putLedger(ada.id, "laptop", changed({ ...publication.facts, commits: [first] }));
    const empty = changed({ ...publication.facts, repositories: [], repositoryDays: [], commits: [],
      pullRequests: [], reviews: [], linearIssues: [], pullRequestLinks: [], commitLinks: [] });
    await store.putLedger(ada.id, "laptop", empty);
    const remaining = await records(ada.id);
    assert.equal(remaining.commits.length, publication.facts.commits.length - 1);
    assert.ok(remaining.repositories.some((entry) => entry.key === first.repositoryKey));
    assert.equal(remaining.commits.some((entry) => entry.sha === first.sha), false);
    // An unchanged desktop publication must still reclaim and restore its record.
    assert.equal((await store.putLedger(ada.id, "desktop", publication)).alreadyCurrent, true);
    assert.equal((await records(ada.id)).commits.length, publication.facts.commits.length);
  });

  it("revokes collector diagnostics and credentials while retaining published history", async () => {
    const token = await store.createToken(ada.id, "laptop", "hash", "ovp_test");
    await store.putLedger(ada.id, token.id, publication);
    assert.equal(await store.deleteToken(ada.id, token.id), true);
    assert.equal(await store.getLedgerHead(ada.id), null);
    assert.equal(await store.findCollectorByTokenHash("hash"), null);
    assert.equal((await records(ada.id)).commits.length, publication.facts.commits.length);
  });

  it("rolls back the entire publication when a late SQL statement fails", async () => {
    await store.putLedger(ada.id, "laptop", publication);
    const before = await records(ada.id);
    const head = await store.getLedgerHead(ada.id);
    const snapshot = await store.getSnapshot(ada.id);
    const [link] = publication.facts.commitLinks;
    assert.ok(link);
    // A duplicate key in the last fact table fails after preceding upserts/deletes.
    const invalid = changed({ ...publication.facts, commits: [], commitLinks: [link, link] });
    await assert.rejects(store.putLedger(ada.id, "laptop", invalid), /cannot affect row a second time/);
    assert.deepEqual(await records(ada.id), before);
    assert.deepEqual(await store.getLedgerHead(ada.id), head);
    assert.deepEqual(await store.getSnapshot(ada.id), snapshot);
  });

  function changed(facts: LedgerFacts): LedgerPublication {
    return { ...publication, facts, publicationId: crypto.randomUUID() };
  }
  function records(userId: string) {
    return store.readLedgerRecords(userId, {
      fromMs: 0, toMs: NOW, fromDay: "1970-01-01", toDay: publication.coverage.toDay,
    });
  }
});
