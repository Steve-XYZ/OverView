/**
 * Facts that are older than the publication covers but count inside it.
 *
 * Coverage is a range of dates, and every record has more than one date. A pull
 * request opened last spring and landed on Tuesday is the obvious case: its creation
 * is history, its merge is this week's work, and the merge is what the dashboard
 * counts. The same holds for an issue filed months ago and completed yesterday.
 *
 * Two things have to be true for those to work, and they pull in opposite
 * directions. The record has to enter the publication at all, and the stale-deletion
 * predicate has to be able to reach it later, or a correction could never land.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createSessionCookie } from "../src/hosted/auth.ts";
import { handlePublish, handleSummary, handleTokens } from "../src/hosted/routes.ts";
import type { SessionDeps } from "../src/hosted/routes.ts";
import { MS_PER_DAY } from "../src/domain/time.ts";
import type { ActivitySummary } from "../src/metrics/summary.ts";
import {
  buildLedgerPublication,
  coverageDays,
  type LedgerPublication,
  type WindowKey,
} from "../src/publish/publish.ts";
import { commit, linearIssue, pullRequest, review, seedDatabase, writeAll, type SeededDb } from "./helpers/seed.ts";
import { cookieHeader, memoryStore, type MemoryStore } from "./helpers/hostedStore.ts";
import { LEDGER_CONFIG, NOW } from "./helpers/ledgerFixture.ts";

const SESSION_SECRET = "session-secret-that-is-at-least-thirty-two-characters";
const TOKENS_URL = "https://overview.example/api/tokens";
const PUBLISH_URL = "https://overview.example/api/publish";

/** Well outside the 180 days a default config publishes. */
const LONG_AGO = 300;
const OLD = 200;

function at(daysAgo: number): string {
  return new Date(NOW - daysAgo * MS_PER_DAY).toISOString();
}

/**
 * One repository holding only work whose creation predates coverage: a pull request
 * opened 200 days ago and merged 3 days ago, an issue filed 300 days ago and
 * completed 2 days ago, and somebody else's ancient pull request reviewed yesterday.
 */
function seedOldWork(): SeededDb {
  const seeded = seedDatabase();
  const syncRunId = seeded.syncRunId;
  writeAll(seeded, {
    commits: [commit({ sha: "fresh01", authoredAt: at(2), syncRunId })],
    pullRequests: [
      pullRequest({
        id: "pr-long-lived",
        number: 40,
        title: "BOS-42 the long haul",
        headRef: "bos-42-long-haul",
        createdAt: at(OLD),
        mergedAt: at(3),
        mergeCommitSha: "merge40",
        syncRunId,
      }),
      // Grace's, opened and landed before coverage begins, reviewed by Ada this week.
      pullRequest({
        id: "pr-ancient",
        number: 12,
        login: "grace",
        title: "Ancient groundwork",
        createdAt: at(LONG_AGO),
        mergedAt: at(OLD),
        syncRunId,
      }),
    ],
    reviews: [
      review({ id: "review-late", prId: "pr-ancient", number: 12, submittedAt: at(1), syncRunId }),
    ],
    linearIssues: [
      linearIssue({
        id: "issue-42",
        identifier: "BOS-42",
        title: "The long haul",
        createdAt: at(LONG_AGO),
        completedAt: at(2),
        syncRunId,
      }),
    ],
  });
  return seeded;
}

describe("coverage boundaries", () => {
  it("publishes a record whose creation predates coverage", () => {
    const seeded = seedOldWork();
    const publication = buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW);
    const { coverage, facts } = publication;

    // The premise: the default config covers 180 days, and this work is older.
    assert.equal(coverageDays(LEDGER_CONFIG), 180);
    const longLived = facts.pullRequests.find((pr) => pr.number === 40);
    const issue = facts.linearIssues.find((entry) => entry.identifier === "BOS-42");
    assert.notEqual(longLived, undefined);
    assert.equal(
      (longLived?.createdAtMs ?? 0) < coverage.fromMs,
      true,
      "the pull request was opened before coverage starts",
    );
    assert.equal((longLived?.mergedAtMs ?? 0) > coverage.fromMs, true);
    assert.equal((issue?.createdAtMs ?? 0) < coverage.fromMs, true);
    assert.equal((issue?.completedAtMs ?? 0) > coverage.fromMs, true);

    // Grace's pull request has no date inside coverage at all, and is still carried,
    // because a review inside coverage points at it and needs its title.
    const ancient = facts.pullRequests.find((pr) => pr.number === 12);
    assert.notEqual(ancient, undefined);
    assert.equal((ancient?.mergedAtMs ?? 0) < coverage.fromMs, true);
    assert.equal(ancient?.authoredByViewer, false);
    seeded.db.close();
  });

  it("counts them on the date the metric uses, in every window", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const seeded = seedOldWork();
    const publication = buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW);
    assert.equal((await publish(store, ada, publication)).status, 200);

    for (const days of ["7", "30", "90"] as const) {
      const hosted = await readSummary(store, ada.cookie, days);
      assert.equal(hosted.totals.pullRequestsMerged, 1, `${days} day merge count`);
      assert.equal(hosted.totals.pullRequestsOpened, 0, `${days} day open count`);
      assert.equal(hosted.linear.completedIssuesTotal, 1, `${days} day completed issues`);
      assert.equal(hosted.totals.reviewsGiven, 1, `${days} day reviews`);
      assert.equal(
        hosted.recentReviews[0]?.title,
        "Ancient groundwork",
        "a review still names the pull request it was left on",
      );
      // The merge time really is the whole 197 days, not a window's worth.
      assert.equal(Math.round(hosted.landedPullRequests[0]?.mergeHours ?? 0), (OLD - 3) * 24);
      assert.deepEqual(
        comparable(hosted),
        comparable(publication.snapshots[days as WindowKey]),
        `the ${days} day window does not reconcile with the local report`,
      );
    }
    seeded.db.close();
  });

  it("keeps them across repeated publications", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const seeded = seedOldWork();

    await publish(store, ada, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW));
    const counts = store.ledgerCounts(ada.userId);

    // A later publication restates the same records. Nothing about the old creation
    // dates may make the stale-deletion predicate mistake them for history.
    for (let round = 1; round <= 3; round += 1) {
      await publish(store, ada, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW + round * 60_000));
      const hosted = await readSummary(store, ada.cookie, "30");
      assert.equal(hosted.totals.pullRequestsMerged, 1, `round ${round}`);
      assert.equal(hosted.linear.completedIssuesTotal, 1, `round ${round}`);
      assert.equal(hosted.linear.coverage.linkedPullRequests, 1, `round ${round}`);
    }
    assert.deepEqual(store.ledgerCounts(ada.userId), counts);
    seeded.db.close();
  });

  it("still corrects one whose metric date moved inside coverage", async () => {
    const store = memoryStore();
    const ada = await onboard(store, 1, "ada");
    const seeded = seedOldWork();
    await publish(store, ada, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW));
    assert.equal((await readSummary(store, ada.cookie, "30")).totals.pullRequestsMerged, 1);

    // The record leaves the publication: whatever its creation date, the merge that
    // put it inside coverage is what the predicate has to reach.
    seeded.db.prepare("DELETE FROM pull_request WHERE source_id = ?").run("pr-long-lived");
    seeded.db.prepare("DELETE FROM linear_issue WHERE source_id = ?").run("issue-42");
    await publish(store, ada, buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW));

    const corrected = await readSummary(store, ada.cookie, "30");
    assert.equal(corrected.totals.pullRequestsMerged, 0, "the stale pull request was removed");
    assert.equal(corrected.linear.completedIssuesTotal, 0, "the stale issue was removed");
    assert.equal(store.ledgerCounts(ada.userId)["pullRequestLinks"], 0);
    // Grace's ancient pull request is out of the predicate's reach by date, and that
    // is correct: it is only ever read through the review that names it.
    assert.equal(corrected.totals.reviewsGiven, 1);
    assert.equal(corrected.recentReviews[0]?.title, "Ancient groundwork");
    seeded.db.close();
  });
});

interface Account {
  readonly userId: string;
  readonly cookie: string;
  readonly token: string;
}

function deps(store: MemoryStore): SessionDeps {
  return { store, sessionSecret: SESSION_SECRET, now: NOW };
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
  return { userId: user.id, cookie, token: body.token };
}

function publish(
  store: MemoryStore,
  account: Account,
  publication: LedgerPublication,
): Promise<Response> {
  return handlePublish(
    new Request(PUBLISH_URL, {
      method: "PUT",
      headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json" },
      body: JSON.stringify(publication),
    }),
    { store },
  );
}

async function readSummary(
  store: MemoryStore,
  cookie: string,
  days: WindowKey,
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
