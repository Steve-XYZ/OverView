import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  createRangeWindow,
  createWindow,
  historyRange,
  monthlyWindows,
  parseRangeWindow,
  parseWindowDays,
} from "../src/metrics/window.ts";
import { localDayKey } from "../src/domain/time.ts";

const NOW = Date.parse("2026-09-03T15:04:00Z");

describe("createWindow", () => {
  it("covers N calendar days ending today, today included", () => {
    const window = createWindow(7, NOW, "UTC");
    assert.equal(window.endDayKey, "2026-09-03");
    assert.equal(window.startDayKey, "2026-08-28");
    assert.equal(window.dayKeys.length, 7);
    assert.equal(window.dayKeys.at(0), "2026-08-28");
    assert.equal(window.dayKeys.at(-1), "2026-09-03");
  });

  it("starts at local midnight in the viewer's zone", () => {
    const window = createWindow(30, NOW, "America/New_York");
    assert.equal(localDayKey(window.fromMs, "America/New_York"), window.startDayKey);
    assert.equal(localDayKey(window.fromMs - 1, "America/New_York") < window.startDayKey, true);
  });

  it("ends at now rather than the end of today", () => {
    const window = createWindow(30, NOW, "UTC");
    assert.equal(window.toMs, NOW);
  });

  it("rejects a nonsense length", () => {
    assert.throws(() => createWindow(0, NOW, "UTC"), RangeError);
    assert.throws(() => createWindow(-5, NOW, "UTC"), RangeError);
  });
});

describe("parseWindowDays", () => {
  it("falls back for anything unusable", () => {
    assert.equal(parseWindowDays(undefined), 30);
    assert.equal(parseWindowDays(""), 30);
    assert.equal(parseWindowDays("abc"), 30);
    assert.equal(parseWindowDays("0"), 30);
    assert.equal(parseWindowDays("4000"), 30);
  });

  it("accepts a sensible number", () => {
    assert.equal(parseWindowDays("7"), 7);
    assert.equal(parseWindowDays("90"), 90);
  });
});

describe("createRangeWindow", () => {
  it("is the same window as the shortcut when it ends today", () => {
    for (const days of [7, 30, 90]) {
      const start = createWindow(days, NOW, "America/New_York").startDayKey;
      assert.deepEqual(
        createRangeWindow(start, localDayKey(NOW, "America/New_York"), NOW, "America/New_York"),
        createWindow(days, NOW, "America/New_York"),
      );
    }
  });

  it("ends a past range at the last millisecond of its final day", () => {
    const window = createRangeWindow("2026-08-01", "2026-08-24", NOW, "UTC");
    assert.equal(window.days, 24);
    assert.equal(window.toMs, Date.parse("2026-08-25T00:00:00Z") - 1);
    assert.equal(window.dayKeys.at(-1), "2026-08-24");
  });

  it("cuts off days that have not happened yet", () => {
    const window = createRangeWindow("2026-09-01", "2026-09-30", NOW, "UTC");
    assert.equal(window.endDayKey, "2026-09-03");
    assert.equal(window.toMs, NOW);
    assert.equal(window.days, 3);
  });
});

describe("parseRangeWindow", () => {
  it("refuses what it cannot answer", () => {
    assert.equal(parseRangeWindow(null, "2026-09-01", NOW, "UTC"), null);
    assert.equal(parseRangeWindow("2026-9-1", "2026-09-02", NOW, "UTC"), null);
    assert.equal(parseRangeWindow("2026-02-30", "2026-03-02", NOW, "UTC"), null);
    assert.equal(parseRangeWindow("2026-09-02", "2026-09-01", NOW, "UTC"), null);
    assert.equal(parseRangeWindow("2026-09-04", "2026-09-05", NOW, "UTC"), null);
    assert.equal(parseRangeWindow("2025-09-02", "2026-09-03", NOW, "UTC"), null);
    assert.equal(parseRangeWindow("2000-01-01", "2026-09-03", NOW, "UTC"), null);
  });

  it("accepts up to a leap year", () => {
    assert.equal(parseRangeWindow("2025-09-03", "2026-09-03", NOW, "UTC")?.days, 366);
  });
});

describe("monthlyWindows", () => {
  it("shows the twelve months ending with the range, the last cut off where it is", () => {
    const window = createRangeWindow("2026-09-01", "2026-09-03", NOW, "UTC");
    const months = monthlyWindows(window, null);
    assert.equal(months.length, 12);
    assert.equal(months[0]?.startDayKey, "2025-10-01");
    assert.equal(months[0]?.endDayKey, "2025-10-31");
    assert.equal(months.at(-1)?.startDayKey, "2026-09-01");
    assert.equal(months.at(-1)?.toMs, NOW);
    assert.deepEqual(historyRange(window, NOW, null), {
      fromMs: Date.parse("2025-10-01T00:00:00Z"),
      toMs: NOW,
      fromDay: "2025-10-01",
      toDay: "2026-09-03",
    });
  });

  it("reaches back to the range's first month when the range is longer", () => {
    const window = createRangeWindow("2025-09-15", "2026-08-31", NOW, "UTC");
    const months = monthlyWindows(window, null);
    assert.equal(months[0]?.startDayKey, "2025-09-01");
    assert.equal(months.at(-1)?.endDayKey, "2026-08-31");
    assert.equal(months.at(-1)?.toMs, Date.parse("2026-09-01T00:00:00Z") - 1);
  });
});

describe("a known start of history", () => {
  it("drops the months before it and starts the trend and the read there", () => {
    const window = createRangeWindow("2026-09-01", "2026-09-03", NOW, "UTC");
    const months = monthlyWindows(window, "2026-03-28");
    assert.deepEqual(
      months.map((month) => [month.startDayKey, month.endDayKey]).slice(0, 2),
      [["2026-03-28", "2026-03-31"], ["2026-04-01", "2026-04-30"]],
    );
    assert.equal(months.length, 7);
    const midnight = Date.parse("2026-03-28T00:00:00Z");
    assert.deepEqual(
      [historyRange(window, NOW, midnight).fromMs, historyRange(window, NOW, midnight).fromDay],
      [midnight, "2026-03-28"],
    );
    assert.equal(historyRange(window, NOW, Date.parse("2024-01-01T00:00:00Z")).fromDay, "2025-10-01");
  });

  it("reads from the exact instant when history starts mid-day in this zone", () => {
    // Another collector's midnight, in a zone eight hours behind.
    const window = createRangeWindow("2026-09-01", "2026-09-03", NOW, "UTC");
    const start = Date.parse("2026-03-28T08:00:00Z");
    const range = historyRange(window, NOW, start);
    assert.equal(range.fromMs, start);
    assert.equal(range.fromDay, "2026-03-29", "the partial day's per-day records are not read");
  });
});
