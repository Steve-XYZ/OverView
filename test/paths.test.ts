import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createExcludeFilter, resolveNumstatPath } from "../src/ingest/paths.ts";
import { DEFAULT_EXCLUDE_PATHS } from "../src/config/config.ts";

describe("createExcludeFilter", () => {
  const isExcluded = createExcludeFilter(DEFAULT_EXCLUDE_PATHS);

  it("matches lockfiles at any depth", () => {
    assert.equal(isExcluded("package-lock.json"), true);
    assert.equal(isExcluded("apps/web/package-lock.json"), true);
    assert.equal(isExcluded("Cargo.lock"), true);
  });

  it("matches generated directories", () => {
    assert.equal(isExcluded("dist/bundle.js"), true);
    assert.equal(isExcluded("packages/core/dist/index.js"), true);
  });

  it("leaves hand-written source alone", () => {
    assert.equal(isExcluded("src/index.ts"), false);
    assert.equal(isExcluded("README.md"), false);
    assert.equal(isExcluded("src/distance.ts"), false, "dist must not match a prefix");
  });

  it("excludes nothing when no patterns are configured", () => {
    assert.equal(createExcludeFilter([])("package-lock.json"), false);
  });
});

describe("resolveNumstatPath", () => {
  it("takes the destination of a braced rename", () => {
    assert.equal(resolveNumstatPath("src/{old => new}/file.ts"), "src/new/file.ts");
  });

  it("takes the destination of a whole-path rename", () => {
    assert.equal(resolveNumstatPath("old/a.ts => new/b.ts"), "new/b.ts");
  });

  it("returns an ordinary path unchanged", () => {
    assert.equal(resolveNumstatPath("src/index.ts"), "src/index.ts");
  });
});
