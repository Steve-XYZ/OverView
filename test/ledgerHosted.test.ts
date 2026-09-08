/**
 * The hosted ledger end to end: publish normalized facts with a collector token,
 * then read the dashboard back out of them.
 *
 * The oracle is the local collector. Every publication carries both the facts and
 * the three summaries the local report produced from the same database, so the
 * hosted answer can be compared against the number a developer would have seen on
 * their own machine — which is the only reason to trust the hosted one.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createSessionCookie } from "../src/hosted/auth.ts";
import { handlePublish, handleSummary, handleTokens } from "../src/hosted/routes.ts";
import type { SessionDeps } from "../src/hosted/routes.ts";
import type { ActivitySummary } from "../src/metrics/summary.ts";
import {
  buildLedgerPublication,
  buildPublication,
  type LedgerPublication,
  type PublicationEnvelope,
  type WindowKey,
} from "../src/publish/publish.ts";
import { commit, linearIssue, pullRequest } from "./helpers/seed.ts";
import { cookieHeader, memoryStore, type MemoryStore } from "./helpers/hostedStore.ts";
import {
  LEDGER_CONFIG,
  NOW,
  SECRET,
  SECRETS,
  seedLedgerDatabase,
} from "./helpers/ledgerFixture.ts";

const SESSION_SECRET = "session-secret-that-is-at-least-thirty-two-characters";
const TOKENS_URL = "https://overview.example/api/tokens";
const PUBLISH_URL = "https://overview.example/api/publish";
const WINDOWS: readonly WindowKey[] = ["7", "30", "90"];

interface Account {
  readonly userId: string;
  readonly login: string;
  readonly cookie: string;
  readonly token: string;
}

describe("the hosted ledger", () => {
  it("reproduces every published window from the stored facts", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const seeded = seedLedgerDatabase();
    const publication = buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW);

    assert.equal((await publish(store, ada.token, publication)).status, 200);

    for (const days of WINDOWS) {
      const hosted = await readSummary(store, ada.cookie, days, "ledger");
      assert.equal(hosted.source, "ledger");
      assert.deepEqual(
        comparable(hosted),
        comparable(publication.snapshots[days]),
        `the ${days} day window does not reconcile with the local report`,
      );
    }
    seeded.db.close();
  });

  it("agrees with the snapshot it fell back to before the ledger existed", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const seeded = seedLedgerDatabase();
    await publish(store, ada.token, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW));

    for (const days of WINDOWS) {
      const ledger = await readSummary(store, ada.cookie, days, "ledger");
      const snapshot = await readSummary(store, ada.cookie, days, "snapshot");
      assert.equal(snapshot.source, "snapshot");
      assert.deepEqual(comparable(ledger), comparable(snapshot), `${days} day windows differ`);
    }
    seeded.db.close();
  });

  it("shows real numbers, not an empty dashboard", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const seeded = seedLedgerDatabase();
    await publish(store, ada.token, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW));

    const week = await readSummary(store, ada.cookie, "7", "ledger");
    // widget01, widget02, widget05, merge7, dupe01 and local01 land in the last 7
    // days; dupe01 is present in two repositories and counts once by SHA.
    assert.equal(week.totals.commitsAuthored, 6);
    assert.equal(week.totals.pullRequestsMerged, 2);
    // #10, #7 and #12 were opened in the window; #11 is Grace's and older.
    assert.equal(week.totals.pullRequestsOpened, 3);
    assert.equal(week.totals.reviewsGiven, 2);
    assert.equal(week.totals.pullRequestsReviewed, 1);
    assert.equal(week.linear.completedIssuesTotal, 2);
    assert.equal(week.linear.coverage.linkedPullRequests, 2);
    // Per-repository counts are per copy, so dupe01 appears under both repositories
    // and the summary warns that 7 copies became 6 commits.
    assert.deepEqual(
      week.repositories.map((repo) => [repo.slug, repo.commitsAuthored, repo.pullRequestsMerged]),
      [
        ["acme/widget", 4, 1],
        ["company/secret", 2, 1],
        ["local-repository-3", 1, 0],
      ],
    );
    assert.equal(
      week.warnings.some((warning) => warning.includes("1 duplicate commit copy was found")),
      true,
    );
    assert.equal(
      week.recentReviews.every((entry) => entry.title === "Tidy the build"),
      true,
      "a review shows the title of the pull request it was left on",
    );
    seeded.db.close();
  });

  it("stores nothing a redacted repository was supposed to keep", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const seeded = seedLedgerDatabase();
    await publish(store, ada.token, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW));

    const persisted = store.serialized();
    for (const secret of SECRETS) {
      assert.equal(persisted.includes(secret), false, `the store holds ${secret}`);
    }
    assert.equal(persisted.includes(SECRET), true, "the repository identity is still stored");
    seeded.db.close();
  });

  it("republishing the same work changes nothing", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const seeded = seedLedgerDatabase();

    const first = await publish(store, ada.token, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW));
    assert.equal(((await first.json()) as { alreadyCurrent: boolean }).alreadyCurrent, false);
    const counts = store.ledgerCounts(ada.userId);
    const before = await readSummary(store, ada.cookie, "30", "ledger");

    // Rebuilt a minute later: the content id covers the records, not the clock.
    const again = buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW + 60_000);
    const second = await publish(store, ada.token, again);
    assert.equal(((await second.json()) as { alreadyCurrent: boolean }).alreadyCurrent, true);

    assert.deepEqual(store.ledgerCounts(ada.userId), counts);
    const after = await readSummary(store, ada.cookie, "30", "ledger");
    assert.deepEqual(comparable(after), comparable(before));
    assert.equal(after.publishedAt, before.publishedAt);
    seeded.db.close();
  });

  it("replaces a pull request and an issue that changed rather than keeping both", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const seeded = seedLedgerDatabase();
    await publish(store, ada.token, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW));
    const counts = store.ledgerCounts(ada.userId);

    const linked = await readSummary(store, ada.cookie, "7", "ledger");
    assert.equal(linked.linear.coverage.linkedPullRequests, 2);
    assert.equal(linked.linear.completedIssuesTotal, 2);

    // The pull request is retitled off its issue and its branch renamed, and the
    // issue it belonged to is reopened.
    seeded.db
      .prepare("UPDATE pull_request SET title = ?, head_ref = ? WHERE source_id = ?")
      .run("Add the widget", "add-the-widget", "pr-widget-10");
    seeded.db
      .prepare("UPDATE linear_issue SET completed_at = NULL, completed_at_ms = NULL, state_type = 'started' WHERE source_id = ?")
      .run("issue-42");

    await publish(store, ada.token, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW));
    const updated = await readSummary(store, ada.cookie, "7", "ledger");

    assert.equal(
      updated.landedPullRequests.some((entry) => entry.title === "Add the widget"),
      true,
    );
    assert.equal(
      updated.landedPullRequests.some((entry) => entry.title.includes("BOS-42")),
      false,
      "the previous title must not survive alongside the new one",
    );
    assert.equal(updated.totals.pullRequestsMerged, 2, "the pull request itself is still there");
    assert.equal(updated.linear.coverage.linkedPullRequests, 1, "its issue link is gone");
    assert.equal(updated.linear.completedIssuesTotal, 1, "the reopened issue is no longer completed");

    assert.equal(store.ledgerCounts(ada.userId)["pullRequests"], counts["pullRequests"]);
    assert.equal(
      (store.ledgerCounts(ada.userId)["pullRequestLinks"] ?? 0) <
        (counts["pullRequestLinks"] ?? 0),
      true,
      "the dropped link is deleted, not merely unreferenced",
    );
    seeded.db.close();
  });

  it("drops a commit a rebase removed and a repository left the config", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const seeded = seedLedgerDatabase();
    await publish(store, ada.token, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW));
    assert.equal((await readSummary(store, ada.cookie, "7", "ledger")).totals.commitsAuthored, 6);

    seeded.db.prepare("DELETE FROM commit_event WHERE sha = ?").run("widget01");
    await publish(store, ada.token, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW));
    const rebased = await readSummary(store, ada.cookie, "7", "ledger");
    assert.equal(rebased.totals.commitsAuthored, 5);
    assert.equal(
      rebased.recentCommits.some((entry) => entry.sha === "widget01"),
      false,
    );

    // Dropping the redacted repository from the config takes its history with it.
    const withoutSecret = {
      ...LEDGER_CONFIG,
      repositories: LEDGER_CONFIG.repositories.filter((repo) => repo.path !== "/src/secret"),
    };
    seeded.db.prepare("DELETE FROM repository WHERE key = ?").run(SECRET);
    await publish(store, ada.token, buildLedgerPublication(seeded.db, withoutSecret, NOW));

    const narrowed = await readSummary(store, ada.cookie, "7", "ledger");
    // A checkout with no remote is published under its position in the config, so
    // removing an earlier entry renumbers it. The rows filed under the old alias are
    // deleted rather than left to double-count, which the totals below confirm.
    assert.deepEqual(
      narrowed.repositories.map((repo) => repo.slug),
      ["acme/widget", "local-repository-2"],
    );
    // widget02, widget05, local01 and the surviving copy of dupe01.
    assert.equal(narrowed.totals.commitsAuthored, 4);
    assert.equal(
      narrowed.warnings.some((warning) => warning.includes("duplicate commit")),
      false,
      "with one copy left there is no duplicate to report",
    );
    assert.equal(narrowed.totals.pullRequestsMerged, 1);
    const persisted = store.serialized();
    assert.equal(persisted.includes(SECRET), false);
    assert.equal(persisted.includes("local-repository-3"), false);
    seeded.db.close();
  });

  it("keeps two accounts' histories entirely apart", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const grace = await onboard(store, 2, "grace");

    const adaDb = seedLedgerDatabase();
    const graceDb = seedLedgerDatabase();
    graceDb.db.prepare("DELETE FROM commit_event WHERE sha NOT IN (?, ?)").run("widget01", "widget02");
    graceDb.db.prepare("DELETE FROM pull_request").run();
    graceDb.db.prepare("DELETE FROM review").run();
    graceDb.db.prepare("DELETE FROM linear_issue").run();

    await publish(store, ada.token, buildLedgerPublication(adaDb.db, LEDGER_CONFIG, NOW));
    await publish(store, grace.token, buildLedgerPublication(graceDb.db, LEDGER_CONFIG, NOW));

    const adaSummary = await readSummary(store, ada.cookie, "7", "ledger");
    const graceSummary = await readSummary(store, grace.cookie, "7", "ledger");

    assert.equal(adaSummary.totals.commitsAuthored, 6);
    assert.equal(adaSummary.account?.githubLogin, "ada");
    assert.equal(graceSummary.totals.commitsAuthored, 2);
    assert.equal(graceSummary.account?.githubLogin, "grace");
    assert.equal(graceSummary.totals.pullRequestsMerged, 0);
    assert.equal(graceSummary.linear.completedIssuesTotal, 0);

    // Ada's later publication cannot disturb Grace's rows, or the reverse.
    await publish(store, ada.token, buildLedgerPublication(adaDb.db, LEDGER_CONFIG, NOW + 1000));
    assert.equal(
      (await readSummary(store, grace.cookie, "7", "ledger")).totals.commitsAuthored,
      2,
    );
    adaDb.db.close();
    graceDb.db.close();
  });

  it("still accepts and serves a snapshot-only publication", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const seeded = seedLedgerDatabase();
    const snapshotOnly = buildPublication(seeded.db, LEDGER_CONFIG, NOW);

    assert.equal((await publish(store, ada.token, snapshotOnly)).status, 200);

    const served = await readSummary(store, ada.cookie, "30");
    assert.equal(served.source, "snapshot");
    assert.deepEqual(comparable(served), comparable(snapshotOnly.snapshots["30"]));

    const ledgerOnly = await handleSummary(
      request("https://overview.example/api/summary?days=30&source=ledger", ada.cookie),
      deps(store),
    );
    assert.equal(ledgerOnly.status, 404);
    seeded.db.close();
  });

  it("refuses a publication that is neither contract", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const response = await publish(store, ada.token, { schemaVersion: 3 } as unknown as PublicationEnvelope);
    assert.equal(response.status, 400);
    assert.equal(store.ledgerCounts(ada.userId)["commits"], undefined);
  });

  it("rejects an unknown source rather than guessing", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const response = await handleSummary(
      request("https://overview.example/api/summary?days=30&source=elsewhere", ada.cookie),
      deps(store),
    );
    assert.equal(response.status, 400);
  });

  it("counts work the collector published for a window it never sent", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const seeded = seedLedgerDatabase();
    const syncRunId = seeded.syncRunId;
    // A pull request that landed 45 days ago: outside 7 and 30, inside 90.
    const at = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();
    const { writeAll } = await import("./helpers/seed.ts");
    writeAll(seeded, {
      commits: [commit({ sha: "older01", authoredAt: at(45), syncRunId })],
      pullRequests: [
        pullRequest({
          id: "pr-widget-9",
          number: 9,
          title: "BOS-99 older work",
          createdAt: at(50),
          mergedAt: at(45),
          syncRunId,
        }),
      ],
      linearIssues: [
        linearIssue({ id: "issue-99", identifier: "BOS-99", title: "Older work", completedAt: at(40), syncRunId }),
      ],
    });

    await publish(store, ada.token, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW));

    const week = await readSummary(store, ada.cookie, "7", "ledger");
    const quarter = await readSummary(store, ada.cookie, "90", "ledger");
    assert.equal(week.totals.pullRequestsMerged, 2);
    assert.equal(quarter.totals.pullRequestsMerged, 3);
    assert.equal(
      quarter.linear.completedIssues.some((issue) => issue.identifier === "BOS-99"),
      true,
    );
    seeded.db.close();
  });
});

/** The fields both sides own. Everything else is assigned by whoever answered. */
function comparable(summary: ActivitySummary): unknown {
  const {
    generatedAt: _generatedAt,
    publishedAt: _publishedAt,
    account: _account,
    source: _source,
    ...rest
  } = summary;
  return rest;
}

function deps(store: MemoryStore): SessionDeps {
  return { store, sessionSecret: SESSION_SECRET, now: NOW };
}

function request(url: string, cookie: string): Request {
  return new Request(url, { headers: { cookie } });
}

async function onboard(store: MemoryStore, githubId: number, login: string): Promise<Account> {
  const user = await store.upsertUser(githubId, login);
  const cookie = cookieHeader(await createSessionCookie(user.id, SESSION_SECRET, NOW));
  const created = await handleTokens(
    new Request(TOKENS_URL, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: `${login}-laptop` }),
    }),
    deps(store),
  );
  assert.equal(created.status, 201);
  const body = (await created.json()) as { token: string };
  return { userId: user.id, login, cookie, token: body.token };
}

function publish(
  store: MemoryStore,
  token: string,
  publication: LedgerPublication | PublicationEnvelope,
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
  days: WindowKey,
  source?: "ledger" | "snapshot",
): Promise<ActivitySummary> {
  const url = new URL("https://overview.example/api/summary");
  url.searchParams.set("days", days);
  if (source !== undefined) url.searchParams.set("source", source);
  const response = await handleSummary(request(url.toString(), cookie), deps(store));
  assert.equal(response.status, 200, `summary ${days}/${source ?? "default"} failed`);
  return (await response.json()) as ActivitySummary;
}
