import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { commit, pullRequest, review, seedDatabase, writeAll } from "./helpers/seed.ts";
import { upsertRepository } from "../src/store/writes.ts";
import { REPOSITORY } from "./helpers/seed.ts";

describe("upserts", () => {
  it("re-syncing an overlapping window updates rather than duplicates", () => {
    const seeded = seedDatabase();
    const record = commit({ sha: "aaa", authoredAt: "2026-09-01T10:00:00Z", syncRunId: seeded.syncRunId });

    writeAll(seeded, { commits: [record] });
    writeAll(seeded, { commits: [{ ...record, subject: "Reworded after a rebase" }] });

    const rows = seeded.db.prepare("SELECT sha, subject FROM commit_event").all();
    assert.equal(rows.length, 1);
    assert.equal((rows[0] as { subject: string }).subject, "Reworded after a rebase");
    seeded.db.close();
  });

  it("keeps one row per pull request and per review across runs", () => {
    const seeded = seedDatabase();
    const pr = pullRequest({
      id: "PR_1",
      number: 1,
      createdAt: "2026-09-01T10:00:00Z",
      syncRunId: seeded.syncRunId,
    });
    const rv = review({
      id: "RV_1",
      prId: "PR_1",
      number: 1,
      submittedAt: "2026-09-02T10:00:00Z",
      syncRunId: seeded.syncRunId,
    });

    writeAll(seeded, { pullRequests: [pr], reviews: [rv] });
    writeAll(seeded, {
      pullRequests: [{ ...pr, state: "MERGED", mergedAt: "2026-09-02T09:00:00Z" }],
      reviews: [rv],
    });

    const prRows = seeded.db.prepare("SELECT state, merged_at FROM pull_request").all();
    const reviewRows = seeded.db.prepare("SELECT id FROM review").all();
    assert.equal(prRows.length, 1);
    assert.equal((prRows[0] as { state: string }).state, "MERGED");
    assert.equal(reviewRows.length, 1);
    seeded.db.close();
  });

  it("stores provenance alongside every commit", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      commits: [commit({ sha: "prov1", authoredAt: "2026-09-01T10:00:00Z", syncRunId: seeded.syncRunId })],
    });

    const row = seeded.db
      .prepare("SELECT source_system, source_id, source_url, sync_run_id FROM commit_event")
      .get() as { source_system: string; source_id: string; source_url: string; sync_run_id: number };

    assert.equal(row.source_system, "git");
    assert.equal(row.source_id, "prov1");
    assert.equal(row.source_url, "https://example.invalid/commit/prov1");
    assert.equal(row.sync_run_id, seeded.syncRunId);
    seeded.db.close();
  });

  it("normalises author email case so identity matching is not case-sensitive", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      commits: [
        commit({
          sha: "case1",
          email: "Ada@Example.COM",
          authoredAt: "2026-09-01T10:00:00Z",
          syncRunId: seeded.syncRunId,
        }),
      ],
    });
    const row = seeded.db.prepare("SELECT author_email FROM commit_event").get() as {
      author_email: string;
    };
    assert.equal(row.author_email, "ada@example.com");
    seeded.db.close();
  });

  it("updates the repository row in place when the ref moves", () => {
    const seeded = seedDatabase();
    const id = upsertRepository(seeded.db, { ...REPOSITORY, headSha: "newhead" });
    assert.equal(id, seeded.repositoryId);

    const rows = seeded.db.prepare("SELECT head_sha FROM repository").all();
    assert.equal(rows.length, 1);
    assert.equal((rows[0] as { head_sha: string }).head_sha, "newhead");
    seeded.db.close();
  });
});
