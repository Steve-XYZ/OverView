import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { maxOf, median, minOf, percentile, sum } from "../src/metrics/stats.ts";

describe("percentile", () => {
  it("returns null for an empty sample", () => {
    assert.equal(median([]), null);
    assert.equal(percentile([], 0.75), null);
  });

  it("takes the middle of an odd sample", () => {
    assert.equal(median([5, 1, 3]), 3);
  });

  it("interpolates across an even sample", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  it("resists the long tail a mean would follow", () => {
    const hours = [2, 3, 4, 5, 400];
    assert.equal(median(hours), 4);
    assert.equal(sum(hours) / hours.length > 80, true);
  });

  it("computes p75", () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 0.75), 4);
  });

  it("does not mutate its input", () => {
    const values = [3, 1, 2];
    median(values);
    assert.deepEqual(values, [3, 1, 2]);
  });
});

describe("min, max and sum", () => {
  it("handle the empty case", () => {
    assert.equal(minOf([]), null);
    assert.equal(maxOf([]), null);
    assert.equal(sum([]), 0);
  });

  it("work on real values", () => {
    assert.equal(minOf([4, 2, 9]), 2);
    assert.equal(maxOf([4, 2, 9]), 9);
    assert.equal(sum([4, 2, 9]), 15);
  });
});
