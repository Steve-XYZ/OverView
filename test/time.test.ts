import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  addDaysToDayKey,
  dayKeysBetween,
  localDayKey,
  startOfLocalDayMs,
  zoneOffsetMs,
} from "../src/domain/time.ts";

describe("localDayKey", () => {
  it("buckets by the viewer's calendar, not UTC", () => {
    // 2026-08-01T02:30Z is still 31 July in New York.
    const instant = Date.parse("2026-08-01T02:30:00Z");
    assert.equal(localDayKey(instant, "UTC"), "2026-08-01");
    assert.equal(localDayKey(instant, "America/New_York"), "2026-07-31");
    assert.equal(localDayKey(instant, "Asia/Tokyo"), "2026-08-01");
  });
});

describe("zoneOffsetMs", () => {
  it("tracks daylight saving", () => {
    const winter = Date.parse("2026-01-15T12:00:00Z");
    const summer = Date.parse("2026-07-15T12:00:00Z");
    assert.equal(zoneOffsetMs(winter, "America/New_York"), -5 * 3_600_000);
    assert.equal(zoneOffsetMs(summer, "America/New_York"), -4 * 3_600_000);
  });
});

describe("startOfLocalDayMs", () => {
  it("lands on local midnight", () => {
    const ms = startOfLocalDayMs("2026-07-15", "America/New_York");
    assert.equal(new Date(ms).toISOString(), "2026-07-15T04:00:00.000Z");
    assert.equal(localDayKey(ms, "America/New_York"), "2026-07-15");
    assert.equal(localDayKey(ms - 1, "America/New_York"), "2026-07-14");
  });

  it("handles the spring-forward day, which has no 00:30 local", () => {
    const ms = startOfLocalDayMs("2026-03-08", "America/New_York");
    assert.equal(localDayKey(ms, "America/New_York"), "2026-03-08");
    assert.equal(localDayKey(ms - 1, "America/New_York"), "2026-03-07");
  });
});

describe("day key arithmetic", () => {
  it("crosses month and year boundaries", () => {
    assert.equal(addDaysToDayKey("2026-03-01", -1), "2026-02-28");
    assert.equal(addDaysToDayKey("2026-01-01", -1), "2025-12-31");
    assert.equal(addDaysToDayKey("2024-02-28", 1), "2024-02-29");
  });

  it("lists an inclusive range", () => {
    assert.deepEqual(dayKeysBetween("2026-08-30", "2026-09-02"), [
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
    assert.deepEqual(dayKeysBetween("2026-08-30", "2026-08-30"), ["2026-08-30"]);
  });
});
