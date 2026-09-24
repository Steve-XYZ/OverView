/**
 * The historical dashboard: arbitrary ranges, the monthly trend, and the shipped-work
 * timeline, locally and through the hosted route.
 *
 * The properties that matter are completeness (every landed pull request and every
 * authored commit in a range is somewhere in the timeline), agreement (a range and
 * the shortcut naming the same days are one window, and the trend counts what the
 * totals count), and redaction (the hosted timeline shows nothing publication
 * removed).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createSessionCookie } from "../src/hosted/auth.ts";
import { handlePublish, handleSummary, handleTokens, type SessionDeps } from "../src/hosted/routes.ts";
import { addDaysToDayKey, currentTimeZone, localDayKey, MS_PER_DAY } from "../src/domain/time.ts";
import type { LedgerFacts } from "../src/domain/facts.ts";
import type { ActivitySummary, ShippedWork } from "../src/metrics/summary.ts";
import { summarize, summarizeWithTrend } from "../src/metrics/summary.ts";
import { createRangeWindow, createWindow, historyRange, type MetricWindow } from "../src/metrics/window.ts";
import { buildLedgerPublication, buildPublication, coverageDays, redactFacts } from "../src/publish/publish.ts";
import { collectFacts } from "../src/store/facts.ts";
import { cookieHeader, memoryStore, type MemoryStore } from "./helpers/hostedStore.ts";
import {
  LEDGER_CONFIG,
  LEDGER_IDENTITY,
  NOW,
  SECRET,
  SECRETS,
  seedLedgerDatabase,
} from "./helpers/ledgerFixture.ts";
import { linearIssue, pullRequest, writeAll, type SeededDb } from "./helpers/seed.ts";

const ZONE = currentTimeZone();
const TODAY = localDayKey(NOW, ZONE);
const SESSION_SECRET = "session-secret-that-is-at-least-thirty-two-characters";

function at(daysAgo: number): string {
  return new Date(NOW - daysAgo * MS_PER_DAY).toISOString();
}

/** The shared fixture, plus the two cases it lacks: an unlinked landed pull request
 * with a squash commit, and a pull request naming an issue that is still open. */
function seedHistory(): SeededDb {
  const seeded = seedLedgerDatabase();
  const syncRunId = seeded.syncRunId;
  writeAll(seeded, {
    pullRequests: [
      pullRequest({
        id: "pr-widget-13",
        number: 13,
        title: "Speed up the build",
        headRef: "faster-build",
        createdAt: at(4),
        mergedAt: at(3),
        mergeCommitSha: "widget02",
        syncRunId,
      }),
      pullRequest({
        id: "pr-widget-14",
        number: 14,
        title: "BOS-50 groundwork",
        headRef: "bos-50-groundwork",
        createdAt: at(5),
        mergedAt: at(4),
        syncRunId,
      }),
    ],
    linearIssues: [
      linearIssue({ id: "issue-50", identifier: "BOS-50", title: "Still going", completedAt: null, syncRunId }),
    ],
  });
  return seeded;
}

function facts(seeded: SeededDb, window: MetricWindow): LedgerFacts {
  return collectFacts(seeded.db, historyRange(window, NOW, null), LEDGER_IDENTITY, ZONE);
}

function stable(summary: ActivitySummary): unknown {
  const { generatedAt: _generatedAt, ...rest } = summary;
  return rest;
}

function timelinePullRequests(shipped: ShippedWork): string[] {
  return [
    ...shipped.issues.flatMap((issue) => issue.pullRequests.map((pr) => `${pr.repository}#${pr.number}`)),
    ...shipped.unlinkedPullRequests.map((pr) => `${pr.repository}#${pr.number}`),
  ];
}

function timelineCommits(shipped: ShippedWork): string[] {
  return [
    ...shipped.issues.flatMap((issue) => [
      ...issue.pullRequests.flatMap((pr) => pr.commits.map((commit) => commit.sha)),
      ...issue.commits.map((commit) => commit.sha),
    ]),
    ...shipped.unlinkedPullRequests.flatMap((pr) => pr.commits.map((commit) => commit.sha)),
    ...shipped.unlinkedCommits.map((commit) => commit.sha),
  ];
}

describe("the shipped-work timeline", () => {
  it("holds every landed pull request and authored commit in the range, and nothing else", () => {
    const seeded = seedHistory();
    const windows = [
      createWindow(7, NOW, ZONE),
      createWindow(30, NOW, ZONE),
      createWindow(90, NOW, ZONE),
      createRangeWindow(addDaysToDayKey(TODAY, -30), addDaysToDayKey(TODAY, -3), NOW, ZONE),
    ];
    for (const window of windows) {
      const all = facts(seeded, window);
      const inRange = (ms: number | null): boolean => ms !== null && ms >= window.fromMs && ms <= window.toMs;
      const name = new Map(all.repositories.map((repo) => [repo.key, repo.slug ?? repo.key]));
      const expectedPullRequests = all.pullRequests
        .filter((pr) => pr.authoredByViewer && inRange(pr.mergedAtMs))
        .map((pr) => `${name.get(pr.repositoryKey)}#${pr.number}`)
        .sort();
      const expectedCommits = all.commits.filter((commit) => inRange(commit.authoredAtMs)).map((c) => c.sha).sort();

      const shipped = summarize(all, window).shipped;
      assert.ok(shipped !== undefined);
      // No pull request here names two issues, so each appears exactly once.
      assert.deepEqual(timelinePullRequests(shipped).sort(), expectedPullRequests, window.startDayKey);
      assert.deepEqual(timelineCommits(shipped).sort(), expectedCommits, window.startDayKey);
    }
    seeded.db.close();
  });

  it("groups work under the issue it names and keeps how each piece was linked", () => {
    const seeded = seedHistory();
    const window = createWindow(7, NOW, ZONE);
    const shipped = summarize(facts(seeded, window), window).shipped;
    assert.ok(shipped !== undefined);

    const issue = (identifier: string) => shipped.issues.find((entry) => entry.identifier === identifier);
    assert.deepEqual(
      shipped.issues.map((entry) => entry.identifier),
      ["BOS-77", "BOS-42", "BOS-50"],
      "most recently shipped first",
    );

    const widget = issue("BOS-42");
    assert.equal(widget?.title, "Add the widget");
    assert.equal(widget?.completedInWindow, true);
    // The squash commit sits under its pull request; its own subject names the issue.
    assert.deepEqual(
      widget?.pullRequests.map((pr) => [pr.number, pr.via, pr.commits.map((commit) => [commit.sha, commit.via])]),
      [[10, ["pr_branch", "pr_title"], [["widget05", "commit_subject"]]]],
    );
    assert.deepEqual(widget?.commits, []);

    // This squash commit's subject names nothing; it belongs through its pull request.
    assert.deepEqual(
      issue("BOS-77")?.pullRequests.flatMap((pr) => pr.commits.map((commit) => [commit.sha, commit.via])),
      [["merge7", "pr_merge_commit"]],
    );
    assert.deepEqual(issue("BOS-77")?.commits, []);

    // Only completed issues are published, so an open one is its identifier alone.
    const open = issue("BOS-50");
    assert.equal(open?.state, null);
    assert.equal(open?.title, "");
    assert.equal(open?.completedInWindow, false);
    assert.deepEqual(open?.pullRequests.map((pr) => pr.number), [14]);

    assert.deepEqual(
      shipped.unlinkedPullRequests.map((pr) => [pr.number, pr.commits.map((commit) => [commit.sha, commit.via])]),
      [[13, [["widget02", "pr_merge_commit"]]]],
    );
    assert.deepEqual(shipped.unlinkedCommits.map((commit) => commit.sha).sort(), ["dupe01", "local01", "widget01"]);
    seeded.db.close();
  });

  it("lists an issue completed in the range even when its work landed earlier", () => {
    const seeded = seedHistory();
    const window = createWindow(90, NOW, ZONE);
    const older = summarize(facts(seeded, window), window).shipped?.issues.find(
      (entry) => entry.identifier === "BOS-99",
    );
    assert.equal(older?.completedInWindow, true);
    assert.deepEqual(older?.pullRequests, []);
    assert.deepEqual(older?.commits, []);
    assert.equal(older?.shippedAt, older?.completedAt);
    seeded.db.close();
  });
});

describe("the monthly trend", () => {
  it("counts each month the way the totals count the range", () => {
    const seeded = seedHistory();
    // Three whole months up to today: their buckets partition the range exactly.
    const start = `${addDaysToDayKey(`${TODAY.slice(0, 7)}-01`, -40).slice(0, 7)}-01`;
    const window = createRangeWindow(start, TODAY, NOW, ZONE);
    const summary = summarizeWithTrend(facts(seeded, window), window, null);
    const months = (summary.trend ?? []).filter((bucket) => bucket.startDay >= start);
    const total = (key: "commitsAuthored" | "pullRequestsMerged" | "reviewsGiven" | "activeDays" | "linearCompleted") =>
      months.reduce((acc, bucket) => acc + bucket[key], 0);

    assert.equal(total("commitsAuthored"), summary.totals.commitsAuthored);
    assert.equal(total("pullRequestsMerged"), summary.totals.pullRequestsMerged);
    assert.equal(total("reviewsGiven"), summary.totals.reviewsGiven);
    assert.equal(total("activeDays"), summary.totals.activeDays);
    assert.equal(total("linearCompleted"), summary.linear.completedIssuesTotal);
    assert.equal(months.at(-1)?.endDay, TODAY);
    seeded.db.close();
  });

  it("counts nothing before history starts, beginning the first month there", () => {
    const seeded = seedHistory();
    const window = createWindow(7, NOW, ZONE);
    const history = addDaysToDayKey(TODAY, -45);
    const trend = summarizeWithTrend(facts(seeded, window), window, history).trend ?? [];
    assert.equal(trend[0]?.startDay, history);
    assert.equal(trend[0]?.month, history.slice(0, 7));
    // widget04 was authored 60 days ago, before history starts, and is not counted.
    const expected = facts(seeded, window).commits.filter(
      (commit) => localDayKey(commit.authoredAtMs, ZONE) >= history && commit.authoredAtMs <= NOW,
    );
    assert.equal(expected.some((commit) => commit.sha === "widget04"), false);
    assert.equal(trend.reduce((acc, month) => acc + month.commitsAuthored, 0), expected.length);
    seeded.db.close();
  });

  it("without a known start, begins at the first month with any activity", () => {
    const seeded = seedHistory();
    const window = createWindow(7, NOW, ZONE);
    const trend = summarizeWithTrend(facts(seeded, window), window, null).trend ?? [];
    const earliest = [60, 40, 25, 20].map((days) => localDayKey(NOW - days * MS_PER_DAY, ZONE).slice(0, 7)).sort()[0];
    assert.equal(trend[0]?.month, earliest);
    assert.equal(trend.at(-1)?.month, TODAY.slice(0, 7));
    seeded.db.close();
  });
});

describe("hosted ranges", () => {
  it("answers a shortcut and the range naming the same days identically", async () => {
    const { store, cookie } = await published();
    for (const days of [7, 30, 90]) {
      const shortcut = await read(store, cookie, { days: String(days) });
      const range = await read(store, cookie, { from: addDaysToDayKey(TODAY, -(days - 1)), to: TODAY });
      assert.equal(shortcut.status, 200);
      assert.equal(range.status, 200);
      assert.deepEqual(
        stable((await range.json()) as ActivitySummary),
        stable((await shortcut.json()) as ActivitySummary),
        `${days} days`,
      );
    }
  });

  it("computes a past range from the stored facts alone", async () => {
    const { store, cookie, seeded } = await published();
    const from = addDaysToDayKey(TODAY, -30);
    const to = addDaysToDayKey(TODAY, -3);
    const response = await read(store, cookie, { from, to });
    assert.equal(response.status, 200);
    const hosted = (await response.json()) as ActivitySummary;
    assert.equal(hosted.window.startDay, from);
    assert.equal(hosted.window.endDay, to);
    assert.equal(hosted.window.days, 28);

    // The oracle: the local database, redacted the way publication redacts it, from
    // where the publication's coverage starts.
    const window = createRangeWindow(from, to, NOW, ZONE);
    const coverageStart = createWindow(coverageDays(LEDGER_CONFIG), NOW, ZONE).startDayKey;
    const local = summarizeWithTrend(redactFacts(facts(seeded, window), LEDGER_CONFIG), window, coverageStart);
    assert.equal(hosted.trend?.[0]?.startDay, coverageStart);
    const { publishedAt: _p, account: _a, source: _s, ...rest } = hosted;
    assert.deepEqual(stable(rest as ActivitySummary), stable(local));
    seeded.db.close();
  });

  it("shows no detail in the timeline that publication removed", async () => {
    const { store, cookie } = await published();
    const response = await read(store, cookie, { from: addDaysToDayKey(TODAY, -89), to: TODAY });
    const body = await response.text();
    for (const secret of SECRETS) assert.equal(body.includes(secret), false, `the timeline shows ${secret}`);

    const shipped = ((JSON.parse(body) as ActivitySummary).shipped)!;
    const secretIssue = shipped.issues.find((issue) => issue.identifier === "BOS-77");
    assert.equal(secretIssue?.title, "");
    assert.equal(secretIssue?.url, null);
    for (const pr of secretIssue?.pullRequests ?? []) {
      assert.equal(pr.repository, "company/secret");
      assert.equal(pr.title, "");
      assert.equal(pr.url, null);
    }
    for (const commit of secretIssue?.commits ?? []) {
      assert.equal(commit.subject, "");
      assert.equal(commit.url, null);
    }
  });

  it("never shows a record published under older redaction rules", async () => {
    // A year-old issue is published while nothing redacted names it. Later, work in the
    // redacted repository names it, but its record is outside the new coverage and is
    // never restated, so the ledger still holds the old title.
    const store = memoryStore();
    const { cookie, token } = await onboard(store);
    const seeded = seedHistory();
    const syncRunId = seeded.syncRunId;
    const earlier = NOW - 200 * MS_PER_DAY;
    writeAll(seeded, {
      linearIssues: [
        linearIssue({ id: "issue-1", identifier: "BOS-1", title: "ACQUIRE ACME CORP", completedAt: at(210), syncRunId }),
      ],
    });
    assert.equal((await publish(store, token, buildLedgerPublication(seeded.db, LEDGER_CONFIG, earlier))).status, 200);
    writeAll(seeded, {
      pullRequests: [
        pullRequest({
          id: "pr-secret-70",
          number: 70,
          title: "Close the deal",
          headRef: "bos-1-deal",
          createdAt: at(4),
          mergedAt: at(3),
          repo: SECRET,
          syncRunId,
        }),
      ],
    });
    assert.equal((await publish(store, token, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW))).status, 200);

    for (const query of [
      { days: "7" },
      { days: "90" },
      { from: addDaysToDayKey(TODAY, -300), to: TODAY },
      { from: addDaysToDayKey(TODAY, -300), to: addDaysToDayKey(TODAY, -150) },
    ]) {
      const response = await read(store, cookie, query);
      const body = await response.text();
      assert.equal(body.includes("ACQUIRE ACME CORP"), false, `${JSON.stringify(query)} shows a stale title`);
    }
    seeded.db.close();
  });

  it("refuses a malformed, reversed, future or overlong range", async () => {
    const { store, cookie } = await published();
    const bad = [
      { from: "2026-02-30", to: TODAY },
      { from: TODAY },
      { from: TODAY, to: addDaysToDayKey(TODAY, -1) },
      { from: addDaysToDayKey(TODAY, 1), to: addDaysToDayKey(TODAY, 2) },
      { from: addDaysToDayKey(TODAY, -366), to: TODAY },
      { from: "2000-01-01", to: TODAY },
    ];
    for (const query of bad) {
      assert.equal((await read(store, cookie, query)).status, 400, JSON.stringify(query));
    }
    const year = await read(store, cookie, { from: addDaysToDayKey(TODAY, -365), to: TODAY });
    assert.equal(year.status, 200);
  });

  it("starts a range at published history and says so", async () => {
    const { store, cookie } = await published();
    const coverageStart = createWindow(coverageDays(LEDGER_CONFIG), NOW, ZONE).startDayKey;
    const response = await read(store, cookie, { from: addDaysToDayKey(TODAY, -200), to: TODAY });
    assert.equal(response.status, 200);
    const summary = (await response.json()) as ActivitySummary;
    assert.equal(summary.window.startDay, coverageStart);
    assert.match(summary.warnings[0] ?? "", /Published history starts on/);

    const before = await read(store, cookie, { from: addDaysToDayKey(TODAY, -300), to: addDaysToDayKey(coverageStart, -1) });
    assert.equal(before.status, 400);
  });

  it("keeps snapshots to the shape they had before the timeline", async () => {
    const seeded = seedHistory();
    const publication = buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW);
    for (const days of ["7", "30", "90"] as const) {
      assert.equal("shipped" in publication.snapshots[days], false);
      assert.equal("trend" in publication.snapshots[days], false);
    }
    seeded.db.close();
  });

  it("cuts a range that runs past today off at now", async () => {
    const { store, cookie } = await published();
    const response = await read(store, cookie, { from: addDaysToDayKey(TODAY, -6), to: addDaysToDayKey(TODAY, 10) });
    const summary = (await response.json()) as ActivitySummary;
    assert.equal(summary.window.endDay, TODAY);
    assert.equal(summary.window.days, 7);
  });

  it("tells a snapshot-only account that a range needs published facts", async () => {
    const store = memoryStore();
    const { cookie, token } = await onboard(store);
    const seeded = seedHistory();
    assert.equal((await publish(store, token, buildPublication(seeded.db, LEDGER_CONFIG, NOW))).status, 200);
    assert.equal((await read(store, cookie, { days: "30" })).status, 200);
    assert.equal((await read(store, cookie, { from: addDaysToDayKey(TODAY, -3), to: TODAY })).status, 409);
    seeded.db.close();
  });
});

async function published(): Promise<{ store: MemoryStore; cookie: string; seeded: SeededDb }> {
  const store = memoryStore();
  const { cookie, token } = await onboard(store);
  const seeded = seedHistory();
  const response = await publish(store, token, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW));
  assert.equal(response.status, 200);
  return { store, cookie, seeded };
}

async function onboard(store: MemoryStore): Promise<{ cookie: string; token: string }> {
  const user = await store.upsertUser(1, "ada");
  const cookie = cookieHeader(await createSessionCookie(user.id, SESSION_SECRET, NOW));
  const created = await handleTokens(
    new Request("https://overview.example/api/tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "laptop" }),
    }),
    deps(store),
  );
  return { cookie, token: ((await created.json()) as { token: string }).token };
}

function publish(store: MemoryStore, token: string, publication: unknown): Promise<Response> {
  return handlePublish(
    new Request("https://overview.example/api/publish", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(publication),
    }),
    { store },
  );
}

function read(store: MemoryStore, cookie: string, query: Record<string, string>): Promise<Response> {
  const url = new URL("https://overview.example/api/summary");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return handleSummary(new Request(url, { headers: { cookie } }), deps(store));
}

function deps(store: MemoryStore): SessionDeps {
  return { store, sessionSecret: SESSION_SECRET, now: NOW };
}
