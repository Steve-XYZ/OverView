import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildSummary } from "../src/metrics/summary.ts";
import { createWindow } from "../src/metrics/window.ts";
import {
  IDENTITY,
  commit,
  linearIssue,
  pullRequest,
  seedDatabase,
  writeAll,
} from "./helpers/seed.ts";
import { upsertLinearIssues } from "../src/store/writes.ts";

const NOW = Date.parse("2026-09-03T18:00:00Z");
const window30 = () => createWindow(30, NOW, "UTC");

describe("linear dashboard slice", () => {
  it("shows completed issues with the pull requests and commits that named them", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      linearIssues: [
        linearIssue({ id: "L_1", identifier: "BOS-2422", completedAt: "2026-09-01T10:00:00Z", syncRunId: seeded.syncRunId }),
      ],
      pullRequests: [
        pullRequest({
          id: "PR_1",
          number: 101,
          title: "BOS-2422: fix the redirect",
          createdAt: "2026-08-30T00:00:00Z",
          mergedAt: "2026-09-01T12:00:00Z",
          headRef: "bos-2422-fix",
          syncRunId: seeded.syncRunId,
        }),
      ],
      commits: [
        {
          ...commit({ sha: "c2422", authoredAt: "2026-09-01T09:00:00Z", syncRunId: seeded.syncRunId }),
          subject: "BOS-2422 fix the redirect",
        },
      ],
    });

    const summary = buildSummary(seeded.db, window30(), IDENTITY);
    assert.equal(summary.linear.completedIssues.length, 1);
    const [issue] = summary.linear.completedIssues;
    assert.equal(issue?.identifier, "BOS-2422");
    assert.equal(issue?.pullRequests.length, 1);
    assert.deepEqual([...(issue?.pullRequests[0]?.via ?? [])].sort(), ["pr_branch", "pr_title"]);
    assert.equal(issue?.commits.length, 1);
    assert.equal(issue?.commits[0]?.via, "commit_subject");
    assert.deepEqual(summary.linear.coverage, {
      landedPullRequests: 1,
      linkedPullRequests: 1,
      unlinkedPullRequests: 0,
      linkedShare: 1,
    });
    seeded.db.close();
  });

  it("windows completed issues on completion date, not on creation", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      linearIssues: [
        linearIssue({ id: "L_old", identifier: "BOS-10", completedAt: "2026-05-01T00:00:00Z", syncRunId: seeded.syncRunId }),
        linearIssue({ id: "L_open", identifier: "BOS-11", completedAt: null, syncRunId: seeded.syncRunId }),
        linearIssue({ id: "L_now", identifier: "BOS-12", completedAt: "2026-09-02T00:00:00Z", syncRunId: seeded.syncRunId }),
      ],
    });

    const identifiers = buildSummary(seeded.db, window30(), IDENTITY).linear.completedIssues.map(
      (issue) => issue.identifier,
    );
    assert.deepEqual(identifiers, ["BOS-12"]);
    seeded.db.close();
  });

  it("links a branch-only pull request and counts coverage over landed pull requests", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      linearIssues: [
        linearIssue({ id: "L_1", identifier: "BOS-2423", completedAt: "2026-09-01T00:00:00Z", syncRunId: seeded.syncRunId }),
      ],
      pullRequests: [
        pullRequest({
          id: "PR_linked",
          number: 1,
          title: "A tidy refactor",
          headRef: "ada/bos-2423-polish",
          createdAt: "2026-09-01T00:00:00Z",
          mergedAt: "2026-09-01T06:00:00Z",
          syncRunId: seeded.syncRunId,
        }),
        pullRequest({
          id: "PR_plain",
          number: 2,
          title: "Unrelated cleanup",
          headRef: "cleanup",
          createdAt: "2026-09-01T00:00:00Z",
          mergedAt: "2026-09-01T07:00:00Z",
          syncRunId: seeded.syncRunId,
        }),
        pullRequest({
          id: "PR_dangling",
          number: 3,
          title: "BOS-9999 nobody synced this",
          createdAt: "2026-09-01T00:00:00Z",
          mergedAt: "2026-09-01T08:00:00Z",
          syncRunId: seeded.syncRunId,
        }),
      ],
    });

    const summary = buildSummary(seeded.db, window30(), IDENTITY);
    assert.deepEqual(summary.linear.coverage, {
      landedPullRequests: 3,
      linkedPullRequests: 1,
      unlinkedPullRequests: 2,
      linkedShare: 1 / 3,
    });
    const [issue] = summary.linear.completedIssues;
    assert.equal(issue?.pullRequests.length, 1);
    assert.equal(issue?.pullRequests[0]?.number, 1);
    seeded.db.close();
  });

  it("attributes a squash commit without the key through its pull request", () => {
    const seeded = seedDatabase();
    const pr = pullRequest({
      id: "PR_1",
      number: 44,
      title: "BOS-2422: fix it",
      createdAt: "2026-09-01T00:00:00Z",
      mergedAt: "2026-09-01T12:00:00Z",
      mergeCommitSha: "squashsha",
      syncRunId: seeded.syncRunId,
    });
    writeAll(seeded, {
      linearIssues: [
        linearIssue({ id: "L_1", identifier: "BOS-2422", completedAt: "2026-09-01T13:00:00Z", syncRunId: seeded.syncRunId }),
      ],
      pullRequests: [pr],
      commits: [
        {
          ...commit({ sha: "squashsha", authoredAt: "2026-09-01T11:00:00Z", syncRunId: seeded.syncRunId }),
          subject: "fix it (#44)",
        },
      ],
    });

    const [issue] = buildSummary(seeded.db, window30(), IDENTITY).linear.completedIssues;
    assert.equal(issue?.commits.length, 1);
    assert.equal(issue?.commits[0]?.via, "pr_merge_commit");
    seeded.db.close();
  });

  it("reports an empty linear section instead of hiding it", () => {
    const seeded = seedDatabase();
    const summary = buildSummary(seeded.db, window30(), IDENTITY);
    assert.deepEqual(summary.linear.completedIssues, []);
    assert.deepEqual(summary.linear.coverage, {
      landedPullRequests: 0,
      linkedPullRequests: 0,
      unlinkedPullRequests: 0,
      linkedShare: null,
    });
    assert.equal(typeof summary.definitions["linearCompleted"], "string");
    assert.equal(typeof summary.definitions["linearCoverage"], "string");
    seeded.db.close();
  });

  it("upserts issues on their Linear id and keeps identifiers unique", () => {
    const seeded = seedDatabase();
    const first = linearIssue({ id: "L_1", identifier: "BOS-2422", syncRunId: seeded.syncRunId });
    upsertLinearIssues(seeded.db, [first]);
    upsertLinearIssues(seeded.db, [{ ...first, title: "Reworded" }]);
    const rows = seeded.db.prepare("SELECT title FROM linear_issue").all() as { title: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.title, "Reworded");
    seeded.db.close();
  });
});
