import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createWindow, parseWindowDays } from "../src/metrics/window.ts";
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
