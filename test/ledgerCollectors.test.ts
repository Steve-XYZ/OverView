/**
 * Two collectors on one account.
 *
 * An account can mint a token per machine, and each machine watches whatever
 * repositories are in its own config. Facts belong to the account and are
 * deduplicated by source identity, but authority to *remove* one belongs to the
 * collector that last wrote it. Without that, a laptop publishing its two
 * repositories would delete the desktop's four, because the laptop's publication is
 * silent about them.
 *
 * Every test here publishes from two machines with their own database and config,
 * which is the only arrangement that can catch it.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { OverviewConfig } from "../src/config/config.ts";
import { defaultConfig } from "../src/config/config.ts";
import { createSessionCookie } from "../src/hosted/auth.ts";
import { handlePublish, handleSummary, handleTokens } from "../src/hosted/routes.ts";
import type { SessionDeps } from "../src/hosted/routes.ts";
import type { ActivitySummary } from "../src/metrics/summary.ts";
import { buildLedgerPublication, type LedgerPublication } from "../src/publish/publish.ts";
import type { RepositoryRecord } from "../src/domain/types.ts";
import { MS_PER_DAY } from "../src/domain/time.ts";
import {
  commit,
  finishSeededSync,
  linearIssue,
  pullRequest,
  review,
  seedDatabase,
  writeAll,
  type SeededDb,
} from "./helpers/seed.ts";
import { cookieHeader, memoryStore, type MemoryStore } from "./helpers/hostedStore.ts";
import { LEDGER_IDENTITY, NOW, SECRET, WIDGET } from "./helpers/ledgerFixture.ts";

const SESSION_SECRET = "session-secret-that-is-at-least-thirty-two-characters";
const TOKENS_URL = "https://overview.example/api/tokens";
const PUBLISH_URL = "https://overview.example/api/publish";

const WIDGET_REPOSITORY: RepositoryRecord = {
  key: WIDGET,
  localPath: "/src/widget",
  provider: "github",
  slug: "acme/widget",
  defaultBranch: "main",
  defaultRef: "origin/main",
  headSha: "widgethead",
  headCommittedAt: "2026-09-03T09:00:00.000Z",
};

const SECRET_REPOSITORY: RepositoryRecord = {
  key: SECRET,
  localPath: "/src/secret",
  provider: "github",
  slug: "company/secret",
  defaultBranch: "main",
  defaultRef: "origin/main",
  headSha: "secrethead",
  headCommittedAt: "2026-09-03T09:00:00.000Z",
};

/** Each machine's config names only the repositories that machine has. */
function configFor(repositories: OverviewConfig["repositories"]): OverviewConfig {
  return {
    ...defaultConfig(),
    identity: LEDGER_IDENTITY,
    repositories,
    publish: { endpoint: "https://overview.example/api/publish", redactLinearDetails: false },
  };
}

const LAPTOP_CONFIG = configFor([{ path: "/src/widget", githubRepo: "acme/widget" }]);
const DESKTOP_CONFIG = configFor([
  { path: "/src/secret", githubRepo: "company/secret", hostedDetail: "redacted" },
]);

function at(daysAgo: number): string {
  return new Date(NOW - daysAgo * MS_PER_DAY).toISOString();
}

/** The laptop: one public repository, Linear configured, one completed issue. */
function laptop(): SeededDb {
  const seeded = seedDatabase(WIDGET_REPOSITORY);
  writeAll(seeded, {
    commits: [
      commit({ sha: "widget01", subject: "BOS-42 add the widget", authoredAt: at(1), syncRunId: seeded.syncRunId }),
      commit({ sha: "widget02", authoredAt: at(3), syncRunId: seeded.syncRunId }),
    ],
    pullRequests: [
      pullRequest({
        id: "pr-widget-10",
        number: 10,
        title: "BOS-42 add the widget",
        headRef: "bos-42",
        createdAt: at(5),
        mergedAt: at(2),
        syncRunId: seeded.syncRunId,
      }),
    ],
    reviews: [
      review({ id: "review-1", prId: "pr-widget-10", number: 10, submittedAt: at(2), syncRunId: seeded.syncRunId }),
    ],
    linearIssues: [
      linearIssue({ id: "issue-42", identifier: "BOS-42", title: "Add the widget", completedAt: at(2), syncRunId: seeded.syncRunId }),
    ],
  });
  finishSeededSync(seeded, { linear: { status: "synced" } });
  return seeded;
}

/** The desktop: one work repository, and no Linear key at all. */
function desktop(): SeededDb {
  const seeded = seedDatabase(SECRET_REPOSITORY);
  writeAll(seeded, {
    commits: [
      commit({ sha: "secret01", authoredAt: at(1), repo: SECRET, syncRunId: seeded.syncRunId }),
      commit({ sha: "secret02", authoredAt: at(4), repo: SECRET, syncRunId: seeded.syncRunId }),
      commit({ sha: "secret03", authoredAt: at(6), repo: SECRET, syncRunId: seeded.syncRunId }),
    ],
    pullRequests: [
      pullRequest({
        id: "pr-secret-7",
        number: 7,
        title: "Rework pricing",
        createdAt: at(6),
        mergedAt: at(1),
        repo: SECRET,
        syncRunId: seeded.syncRunId,
      }),
    ],
  });
  finishSeededSync(seeded, { linear: { status: "missing_key" } });
  return seeded;
}

describe("two collectors on one account", () => {
  it("keeps each collector's repositories when the other publishes", async () => {
    const store = memoryStore();
    const account = await onboard(store, 1, "ada");
    const first = await mintToken(store, account, "laptop");
    const second = await mintToken(store, account, "desktop");
    const laptopDb = laptop();
    const desktopDb = desktop();

    await publish(store, first, buildLedgerPublication(laptopDb.db, LAPTOP_CONFIG, NOW));
    const afterLaptop = await readSummary(store, account.cookie, 7);
    assert.equal(afterLaptop.totals.commitsAuthored, 2);

    await publish(store, second, buildLedgerPublication(desktopDb.db, DESKTOP_CONFIG, NOW));

    // The account now sees both machines. Before authority was scoped to the
    // credential, the desktop's publication deleted the laptop's two commits.
    const both = await readSummary(store, account.cookie, 7);
    assert.equal(both.totals.commitsAuthored, 5);
    assert.equal(both.totals.pullRequestsMerged, 2);
    assert.equal(both.totals.reviewsGiven, 1);
    assert.deepEqual(
      both.repositories.map((repo) => [repo.slug, repo.commitsAuthored]),
      [
        ["acme/widget", 2],
        ["company/secret", 3],
      ],
    );

    // And publishing from the laptop again does not undo the desktop.
    await publish(store, first, buildLedgerPublication(laptopDb.db, LAPTOP_CONFIG, NOW));
    assert.equal((await readSummary(store, account.cookie, 7)).totals.commitsAuthored, 5);
    laptopDb.db.close();
    desktopDb.db.close();
  });

  it("does not blank Linear because one machine has no key for it", async () => {
    const store = memoryStore();
    const account = await onboard(store, 1, "ada");
    const first = await mintToken(store, account, "laptop");
    const second = await mintToken(store, account, "desktop");
    const laptopDb = laptop();
    const desktopDb = desktop();

    await publish(store, first, buildLedgerPublication(laptopDb.db, LAPTOP_CONFIG, NOW));
    // The desktop publishes last and reports missing_key, having no Linear at all.
    await publish(store, second, buildLedgerPublication(desktopDb.db, DESKTOP_CONFIG, NOW));

    const summary = await readSummary(store, account.cookie, 7);
    assert.equal(summary.linear.syncStatus, "synced", "the laptop really does sync Linear");
    assert.equal(summary.linear.completedIssuesTotal, 1);
    assert.deepEqual(
      summary.linear.completedIssues.map((issue) => issue.identifier),
      ["BOS-42"],
    );
    laptopDb.db.close();
    desktopDb.db.close();
  });

  it("stores an overlapping fact once and lets either collector correct it", async () => {
    const store = memoryStore();
    const account = await onboard(store, 1, "ada");
    const first = await mintToken(store, account, "laptop");
    const second = await mintToken(store, account, "clone");
    const laptopDb = laptop();
    // A second checkout of the same repository, sharing widget01 and adding one.
    const cloneDb = seedDatabase(WIDGET_REPOSITORY);
    writeAll(cloneDb, {
      commits: [
        commit({ sha: "widget01", subject: "BOS-42 add the widget", authoredAt: at(1), syncRunId: cloneDb.syncRunId }),
        commit({ sha: "widget09", authoredAt: at(2), syncRunId: cloneDb.syncRunId }),
      ],
    });
    finishSeededSync(cloneDb, { linear: { status: "missing_key" } });

    await publish(store, first, buildLedgerPublication(laptopDb.db, LAPTOP_CONFIG, NOW));
    await publish(store, second, buildLedgerPublication(cloneDb.db, LAPTOP_CONFIG, NOW));

    // widget01, widget02 and widget09: the shared SHA is one fact, not two rows.
    const summary = await readSummary(store, account.cookie, 7);
    assert.equal(summary.totals.commitsAuthored, 3);
    assert.equal(store.ledgerCounts(account.userId)["commits"], 3);

    // The clone published widget01 last, so it owns it. When the clone loses it to a
    // rebase, the clone's own publication is what removes it.
    cloneDb.db.prepare("DELETE FROM commit_event WHERE sha = ?").run("widget01");
    await publish(store, second, buildLedgerPublication(cloneDb.db, LAPTOP_CONFIG, NOW));
    assert.equal((await readSummary(store, account.cookie, 7)).totals.commitsAuthored, 2);

    // The laptop still has it, so its next publication puts it back.
    await publish(store, first, buildLedgerPublication(laptopDb.db, LAPTOP_CONFIG, NOW));
    assert.equal((await readSummary(store, account.cookie, 7)).totals.commitsAuthored, 3);
    laptopDb.db.close();
    cloneDb.db.close();
  });

  it("removes only what the publishing collector had authority over", async () => {
    const store = memoryStore();
    const account = await onboard(store, 1, "ada");
    const first = await mintToken(store, account, "laptop");
    const second = await mintToken(store, account, "desktop");
    const laptopDb = laptop();
    const desktopDb = desktop();

    await publish(store, first, buildLedgerPublication(laptopDb.db, LAPTOP_CONFIG, NOW));
    await publish(store, second, buildLedgerPublication(desktopDb.db, DESKTOP_CONFIG, NOW));
    assert.equal(store.ledgerCounts(account.userId)["commits"], 5);
    assert.equal(store.ledgerCounts(account.userId, first.collectorId)["commits"], 2);
    assert.equal(store.ledgerCounts(account.userId, second.collectorId)["commits"], 3);

    // A rebase on the desktop drops one of its commits.
    desktopDb.db.prepare("DELETE FROM commit_event WHERE sha = ?").run("secret02");
    await publish(store, second, buildLedgerPublication(desktopDb.db, DESKTOP_CONFIG, NOW));

    const summary = await readSummary(store, account.cookie, 7);
    assert.equal(summary.totals.commitsAuthored, 4);
    assert.equal(store.ledgerCounts(account.userId, first.collectorId)["commits"], 2);
    assert.equal(store.ledgerCounts(account.userId, second.collectorId)["commits"], 2);
    assert.equal(
      summary.recentCommits.some((entry) => entry.sha === "widget01"),
      true,
      "the laptop's commits are untouched by the desktop's correction",
    );
    laptopDb.db.close();
    desktopDb.db.close();
  });

  it("keeps a shared repository listed when one machine stops watching it", async () => {
    const store = memoryStore();
    const account = await onboard(store, 1, "ada");
    const first = await mintToken(store, account, "laptop");
    const second = await mintToken(store, account, "clone");
    const laptopDb = laptop();
    const cloneDb = seedDatabase(WIDGET_REPOSITORY);
    writeAll(cloneDb, {
      commits: [commit({ sha: "widget09", authoredAt: at(2), syncRunId: cloneDb.syncRunId })],
    });
    finishSeededSync(cloneDb, { linear: { status: "missing_key" } });

    await publish(store, first, buildLedgerPublication(laptopDb.db, LAPTOP_CONFIG, NOW));
    await publish(store, second, buildLedgerPublication(cloneDb.db, LAPTOP_CONFIG, NOW));

    // The clone drops the repository entirely and publishes an empty config.
    const emptyConfig = configFor([]);
    cloneDb.db.prepare("DELETE FROM repository").run();
    await publish(store, second, buildLedgerPublication(cloneDb.db, emptyConfig, NOW));

    const summary = await readSummary(store, account.cookie, 7);
    assert.deepEqual(
      summary.repositories.map((repo) => repo.slug),
      ["acme/widget"],
      "the laptop still watches it, so the row survives and keeps its name",
    );
    assert.equal(summary.totals.commitsAuthored, 2, "only the clone's own commit went");
    assert.equal(
      summary.recentCommits.every((entry) => entry.repository === "acme/widget"),
      true,
    );
    laptopDb.db.close();
    cloneDb.db.close();
  });

  it("keeps the history of a collector whose token was revoked", async () => {
    const store = memoryStore();
    const account = await onboard(store, 1, "ada");
    const first = await mintToken(store, account, "laptop");
    const second = await mintToken(store, account, "desktop");
    const laptopDb = laptop();
    const desktopDb = desktop();

    await publish(store, first, buildLedgerPublication(laptopDb.db, LAPTOP_CONFIG, NOW));
    await publish(store, second, buildLedgerPublication(desktopDb.db, DESKTOP_CONFIG, NOW));

    const revoked = await handleTokens(
      new Request(`${TOKENS_URL}?id=${second.collectorId}`, {
        method: "DELETE",
        headers: { cookie: account.cookie },
      }),
      deps(store),
    );
    assert.equal(revoked.status, 200);

    // The credential is gone; the facts it published are the account's and remain.
    const summary = await readSummary(store, account.cookie, 7);
    assert.equal(summary.totals.commitsAuthored, 5);
    assert.equal((await publish(store, second, buildLedgerPublication(desktopDb.db, DESKTOP_CONFIG, NOW))).status, 401);
    assert.equal((await readSummary(store, account.cookie, 7)).totals.commitsAuthored, 5);
    laptopDb.db.close();
    desktopDb.db.close();
  });

  it("reports a repeat publication as current without disturbing the other collector", async () => {
    const store = memoryStore();
    const account = await onboard(store, 1, "ada");
    const first = await mintToken(store, account, "laptop");
    const second = await mintToken(store, account, "desktop");
    const laptopDb = laptop();
    const desktopDb = desktop();

    await publish(store, first, buildLedgerPublication(laptopDb.db, LAPTOP_CONFIG, NOW));
    await publish(store, second, buildLedgerPublication(desktopDb.db, DESKTOP_CONFIG, NOW));
    const counts = store.ledgerCounts(account.userId);
    const before = await readSummary(store, account.cookie, 30);

    for (let round = 0; round < 3; round += 1) {
      const laptopAgain = await publish(
        store,
        first,
        buildLedgerPublication(laptopDb.db, LAPTOP_CONFIG, NOW + round * 1000),
      );
      assert.equal(((await laptopAgain.json()) as { alreadyCurrent: boolean }).alreadyCurrent, true);
      const desktopAgain = await publish(
        store,
        second,
        buildLedgerPublication(desktopDb.db, DESKTOP_CONFIG, NOW + round * 1000),
      );
      assert.equal(((await desktopAgain.json()) as { alreadyCurrent: boolean }).alreadyCurrent, true);
    }

    assert.deepEqual(store.ledgerCounts(account.userId), counts);
    const after = await readSummary(store, account.cookie, 30);
    assert.deepEqual(stripVolatile(after), stripVolatile(before));
    laptopDb.db.close();
    desktopDb.db.close();
  });

  it("keeps two accounts apart when both run several collectors", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const grace = await onboard(store, 2, "grace");
    const adaLaptop = await mintToken(store, ada, "laptop");
    const adaDesktop = await mintToken(store, ada, "desktop");
    const graceLaptop = await mintToken(store, grace, "laptop");

    const adaWidget = laptop();
    const adaSecret = desktop();
    const graceWidget = seedDatabase(WIDGET_REPOSITORY);
    writeAll(graceWidget, {
      commits: [commit({ sha: "grace01", authoredAt: at(1), syncRunId: graceWidget.syncRunId })],
    });

    await publish(store, adaLaptop, buildLedgerPublication(adaWidget.db, LAPTOP_CONFIG, NOW));
    await publish(store, adaDesktop, buildLedgerPublication(adaSecret.db, DESKTOP_CONFIG, NOW));
    await publish(store, graceLaptop, buildLedgerPublication(graceWidget.db, LAPTOP_CONFIG, NOW));

    assert.equal((await readSummary(store, ada.cookie, 7)).totals.commitsAuthored, 5);
    assert.equal((await readSummary(store, grace.cookie, 7)).totals.commitsAuthored, 1);

    // Grace's collector shares a repository key with Ada's, and still cannot reach
    // Ada's rows: her publication names the same repository but a different account.
    assert.equal(store.ledgerCounts(ada.userId)["commits"], 5);
    assert.equal(store.ledgerCounts(grace.userId)["commits"], 1);
    adaWidget.db.close();
    adaSecret.db.close();
    graceWidget.db.close();
  });
});

interface Account {
  readonly userId: string;
  readonly cookie: string;
}

interface Collector {
  readonly token: string;
  readonly collectorId: string;
}

function deps(store: MemoryStore): SessionDeps {
  return { store, sessionSecret: SESSION_SECRET, now: NOW };
}

async function onboard(store: MemoryStore, githubId: number, login: string): Promise<Account> {
  const user = await store.upsertUser(githubId, login);
  return { userId: user.id, cookie: cookieHeader(await createSessionCookie(user.id, SESSION_SECRET, NOW)) };
}

async function mintToken(store: MemoryStore, account: Account, name: string): Promise<Collector> {
  const created = await handleTokens(
    new Request(TOKENS_URL, {
      method: "POST",
      headers: { cookie: account.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    deps(store),
  );
  assert.equal(created.status, 201);
  const body = (await created.json()) as { token: string; record: { id: string } };
  return { token: body.token, collectorId: body.record.id };
}

function publish(
  store: MemoryStore,
  collector: Collector,
  publication: LedgerPublication,
): Promise<Response> {
  return handlePublish(
    new Request(PUBLISH_URL, {
      method: "PUT",
      headers: { authorization: `Bearer ${collector.token}`, "content-type": "application/json" },
      body: JSON.stringify(publication),
    }),
    { store },
  );
}

async function readSummary(
  store: MemoryStore,
  cookie: string,
  days: number,
): Promise<ActivitySummary> {
  const response = await handleSummary(
    new Request(`https://overview.example/api/summary?days=${days}&source=ledger`, {
      headers: { cookie },
    }),
    deps(store),
  );
  assert.equal(response.status, 200);
  return (await response.json()) as ActivitySummary;
}

function stripVolatile(summary: ActivitySummary): unknown {
  const { generatedAt: _generatedAt, publishedAt: _publishedAt, ...rest } = summary;
  return rest;
}
