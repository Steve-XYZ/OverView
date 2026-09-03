import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildSummary } from "../src/metrics/summary.ts";
import { createWindow } from "../src/metrics/window.ts";
import { formatLocalDay, renderTextReport } from "../src/report/text.ts";
import { finishSyncRun } from "../src/store/writes.ts";
import { IDENTITY, commit, pullRequest, seedDatabase, writeAll } from "./helpers/seed.ts";

describe("formatLocalDay", () => {
  it("uses the report time zone instead of the timestamp's UTC date", () => {
    assert.equal(
      formatLocalDay("2026-08-30T03:04:06.000Z", "America/Havana"),
      "2026-08-29",
    );
  });

  it("preserves an invalid timestamp for diagnosis", () => {
    assert.equal(formatLocalDay("not-a-timestamp", "UTC"), "not-a-timestamp");
  });

  it("renders detail dates in the same local zone as the report window", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      commits: [
        commit({
          sha: "near-midnight",
          authoredAt: "2026-08-30T03:04:06.000Z",
          syncRunId: seeded.syncRunId,
        }),
      ],
    });
    const summary = buildSummary(
      seeded.db,
      createWindow(7, Date.parse("2026-09-03T18:00:00Z"), "America/Havana"),
      IDENTITY,
    );

    assert.match(renderTextReport(summary), /2026-08-29  near-mid/);
    seeded.db.close();
  });

  it("does not present missing Linear data as zero-percent coverage", () => {
    const seeded = seedDatabase();
    writeAll(seeded, {
      pullRequests: [
        pullRequest({
          id: "PR_1",
          number: 1,
          createdAt: "2026-09-01T00:00:00Z",
          mergedAt: "2026-09-01T01:00:00Z",
          syncRunId: seeded.syncRunId,
        }),
      ],
    });
    finishSyncRun(
      seeded.db,
      seeded.syncRunId,
      "ok",
      JSON.stringify({ linear: { issues: 0, error: null, status: "missing_key" } }),
    );
    const summary = buildSummary(
      seeded.db,
      createWindow(7, Date.parse("2026-09-03T18:00:00Z"), "UTC"),
      IDENTITY,
    );
    const report = renderTextReport(summary);

    assert.match(report, /Linear unavailable \(LINEAR_API_KEY was missing on the last sync\)/);
    assert.doesNotMatch(report, /PR coverage 0\/1 linked \(0%\)/);
    assert.match(report, /lines include excludePaths/);
    seeded.db.close();
  });
});
