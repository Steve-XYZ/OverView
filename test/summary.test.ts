import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildSummary } from "../src/metrics/summary.ts";
import { createWindow } from "../src/metrics/window.ts";
import { IDENTITY, commit, pullRequest, review, seedDatabase, writeAll } from "./helpers/seed.ts";

const NOW = Date.parse("2026-09-03T18:00:00Z");
const window30 = () => createWindow(30, NOW, "UTC");

describe("buildSummary", () => {
  it("counts only commits authored by the configured identity", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      commits: [
        commit({ sha: "mine1", authoredAt: "2026-09-01T10:00:00Z", syncRunId: seeded.syncRunId }),
        commit({ sha: "mine2", authoredAt: "2026-09-02T10:00:00Z", syncRunId: seeded.syncRunId }),
        commit({
          sha: "theirs",
          email: "grace@example.com",
          authoredAt: "2026-09-02T11:00:00Z",
          syncRunId: seeded.syncRunId,
        }),
      ],
    });

    const summary = buildSummary(seeded.db, window30(), IDENTITY);
    assert.equal(summary.totals.commitsLanded, 2);
    seeded.db.close();
  });

  it("excludes merge commits from the count and from change volume", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      commits: [
        commit({ sha: "work", authoredAt: "2026-09-01T10:00:00Z", additions: 30, deletions: 4, syncRunId: seeded.syncRunId }),
        commit({
          sha: "merge",
          authoredAt: "2026-09-01T11:00:00Z",
          parents: 2,
          additions: 999,
          deletions: 999,
          syncRunId: seeded.syncRunId,
        }),
      ],
    });

    const summary = buildSummary(seeded.db, window30(), IDENTITY);
    assert.equal(summary.totals.commitsLanded, 1);
    assert.equal(summary.totals.additions, 30);
    assert.equal(summary.totals.deletions, 4);
    seeded.db.close();
  });

  it("windows commits on when they landed, not when they were written", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      commits: [
        // Written four months ago, rebased onto main yesterday.
        commit({
          sha: "old-work",
          authoredAt: "2026-05-01T10:00:00Z",
          committedAt: "2026-09-02T10:00:00Z",
          syncRunId: seeded.syncRunId,
        }),
        // Written yesterday but still unmerged four months ago is impossible; the
        // inverse case is a commit that landed before the window opened.
        commit({
          sha: "already-landed",
          authoredAt: "2026-09-01T10:00:00Z",
          committedAt: "2026-05-02T10:00:00Z",
          syncRunId: seeded.syncRunId,
        }),
      ],
    });

    const summary = buildSummary(seeded.db, window30(), IDENTITY);
    assert.equal(summary.totals.commitsLanded, 1);
    assert.equal(summary.recentCommits[0]?.sha, "old-work");
    seeded.db.close();
  });

  it("separates pull requests opened from pull requests landed", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      pullRequests: [
        pullRequest({ id: "PR_1", number: 1, createdAt: "2026-09-01T00:00:00Z", mergedAt: "2026-09-02T00:00:00Z", syncRunId: seeded.syncRunId }),
        pullRequest({ id: "PR_2", number: 2, createdAt: "2026-09-02T00:00:00Z", syncRunId: seeded.syncRunId }),
        // Opened before the window, landed inside it.
        pullRequest({ id: "PR_3", number: 3, createdAt: "2026-07-01T00:00:00Z", mergedAt: "2026-09-03T00:00:00Z", syncRunId: seeded.syncRunId }),
        // Someone else's.
        pullRequest({ id: "PR_4", number: 4, login: "grace", createdAt: "2026-09-01T00:00:00Z", mergedAt: "2026-09-01T06:00:00Z", syncRunId: seeded.syncRunId }),
      ],
    });

    const summary = buildSummary(seeded.db, window30(), IDENTITY);
    assert.equal(summary.totals.pullRequestsOpened, 2, "PR_1 and PR_2");
    assert.equal(summary.totals.pullRequestsMerged, 2, "PR_1 and PR_3");
    seeded.db.close();
  });

  it("reports merge time as a median over pull requests landed in the window", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      pullRequests: [
        pullRequest({ id: "PR_1", number: 1, createdAt: "2026-09-01T00:00:00Z", mergedAt: "2026-09-01T02:00:00Z", syncRunId: seeded.syncRunId }),
        pullRequest({ id: "PR_2", number: 2, createdAt: "2026-09-01T00:00:00Z", mergedAt: "2026-09-01T04:00:00Z", syncRunId: seeded.syncRunId }),
        pullRequest({ id: "PR_3", number: 3, createdAt: "2026-08-01T00:00:00Z", mergedAt: "2026-09-01T00:00:00Z", syncRunId: seeded.syncRunId }),
      ],
    });

    const summary = buildSummary(seeded.db, window30(), IDENTITY);
    assert.equal(summary.mergeTimeHours.count, 3);
    assert.equal(summary.mergeTimeHours.median, 4);
    assert.equal(summary.mergeTimeHours.fastest, 2);
    assert.equal(summary.mergeTimeHours.slowest, 31 * 24);
    seeded.db.close();
  });

  it("counts every review submission but distinct pull requests separately", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      pullRequests: [
        pullRequest({ id: "PR_9", number: 9, login: "grace", createdAt: "2026-09-01T00:00:00Z", syncRunId: seeded.syncRunId }),
      ],
      reviews: [
        review({ id: "RV_1", prId: "PR_9", number: 9, submittedAt: "2026-09-01T10:00:00Z", syncRunId: seeded.syncRunId }),
        review({ id: "RV_2", prId: "PR_9", number: 9, submittedAt: "2026-09-02T10:00:00Z", syncRunId: seeded.syncRunId }),
        review({ id: "RV_3", prId: "PR_9", number: 9, login: "grace", submittedAt: "2026-09-02T11:00:00Z", syncRunId: seeded.syncRunId }),
      ],
    });

    const summary = buildSummary(seeded.db, window30(), IDENTITY);
    assert.equal(summary.totals.reviewsGiven, 2, "Grace's review is not mine");
    assert.equal(summary.totals.pullRequestsReviewed, 1);
    assert.equal(summary.recentReviews[0]?.title, "Pull request 9");
    seeded.db.close();
  });

  it("counts an active day once however much happened on it", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      commits: [
        commit({ sha: "c1", authoredAt: "2026-09-01T09:00:00Z", syncRunId: seeded.syncRunId }),
        commit({ sha: "c2", authoredAt: "2026-09-01T17:00:00Z", syncRunId: seeded.syncRunId }),
        commit({ sha: "c3", authoredAt: "2026-09-02T09:00:00Z", syncRunId: seeded.syncRunId }),
      ],
      pullRequests: [
        pullRequest({ id: "PR_1", number: 1, createdAt: "2026-09-01T12:00:00Z", syncRunId: seeded.syncRunId }),
      ],
      reviews: [
        review({ id: "RV_1", prId: "PR_1", number: 1, submittedAt: "2026-08-28T12:00:00Z", syncRunId: seeded.syncRunId }),
      ],
    });

    const summary = buildSummary(seeded.db, window30(), IDENTITY);
    assert.equal(summary.totals.activeDays, 3, "1 Sept, 2 Sept and 28 Aug");
    seeded.db.close();
  });

  it("emits one daily bucket per day in the window, gaps included", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      commits: [commit({ sha: "c1", authoredAt: "2026-09-02T09:00:00Z", syncRunId: seeded.syncRunId })],
    });

    const summary = buildSummary(seeded.db, window30(), IDENTITY);
    assert.equal(summary.daily.length, 30);
    assert.equal(summary.daily.at(-1)?.date, "2026-09-03");
    assert.equal(summary.daily.find((d) => d.date === "2026-09-02")?.commitsLanded, 1);
    assert.equal(summary.daily.find((d) => d.date === "2026-09-01")?.commitsLanded, 0);
    seeded.db.close();
  });

  it("counts nothing and says why when identity is unset", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      commits: [commit({ sha: "c1", authoredAt: "2026-09-02T09:00:00Z", syncRunId: seeded.syncRunId })],
    });

    const summary = buildSummary(seeded.db, window30(), { githubLogin: null, gitEmails: [] });
    assert.equal(summary.totals.commitsLanded, 0);
    assert.equal(
      summary.warnings.some((warning) => warning.includes("identity.gitEmails")),
      true,
    );
    seeded.db.close();
  });

  it("reports excluded churn without folding it into change volume", () => {
    const seeded = seedDatabase();
    const record = commit({ sha: "lock", authoredAt: "2026-09-01T09:00:00Z", additions: 5, deletions: 1, syncRunId: seeded.syncRunId });
    writeAll(seeded, {
      commits: [
        {
          ...record,
          diff: { ...record.diff, excludedAdditions: 4000, excludedDeletions: 3800, excludedFiles: 1 },
        },
      ],
    });

    const summary = buildSummary(seeded.db, window30(), IDENTITY);
    assert.equal(summary.totals.additions, 5);
    assert.equal(summary.totals.excludedAdditions, 4000);
    assert.equal(summary.totals.excludedDeletions, 3800);
    seeded.db.close();
  });
});
