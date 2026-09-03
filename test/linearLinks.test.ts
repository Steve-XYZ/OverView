import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  extractLinearIdentifiers,
  linkCommit,
  linkPullRequest,
} from "../src/domain/linear.ts";

describe("extractLinearIdentifiers", () => {
  it("finds an identifier in a pull request title", () => {
    assert.deepEqual(extractLinearIdentifiers("BOS-2422: fix the login redirect"), ["BOS-2422"]);
  });

  it("matches lower-case branch names and normalises to upper case", () => {
    assert.deepEqual(extractLinearIdentifiers("feature/bos-2422-fix"), ["BOS-2422"]);
  });

  it("returns every distinct identifier in order of first appearance", () => {
    assert.deepEqual(extractLinearIdentifiers("BOS-1 then bos-2 then BOS-1 again"), [
      "BOS-1",
      "BOS-2",
    ]);
  });

  it("ignores single-character prefixes that are usually versions, not issues", () => {
    assert.deepEqual(extractLinearIdentifiers("bump v-2"), []);
  });

  it("returns nothing for empty or missing text", () => {
    assert.deepEqual(extractLinearIdentifiers(""), []);
    assert.deepEqual(extractLinearIdentifiers(null), []);
    assert.deepEqual(extractLinearIdentifiers(undefined), []);
  });
});

describe("linkPullRequest", () => {
  const known = new Set(["BOS-2422", "BOS-2423"]);

  it("links through the title and keeps the evidence", () => {
    const links = linkPullRequest("BOS-2422: fix it", null, known);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.identifier, "BOS-2422");
    assert.deepEqual([...(links[0]?.via ?? [])], ["pr_title"]);
  });

  it("links through the source branch", () => {
    const links = linkPullRequest("A tidy refactor", "ada/bos-2423-polish", known);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.identifier, "BOS-2423");
    assert.deepEqual([...(links[0]?.via ?? [])], ["pr_branch"]);
  });

  it("keeps both evidences when title and branch name the same issue", () => {
    const links = linkPullRequest("BOS-2422: fix it", "bos-2422-fix", known);
    assert.equal(links.length, 1);
    assert.deepEqual([...(links[0]?.via ?? [])].sort(), ["pr_branch", "pr_title"]);
  });

  it("links to every known identifier it names", () => {
    const links = linkPullRequest("BOS-2422 and BOS-2423", null, known);
    assert.deepEqual(
      links.map((link) => link.identifier).sort(),
      ["BOS-2422", "BOS-2423"],
    );
  });

  it("ignores identifiers that are not synced issues", () => {
    assert.equal(linkPullRequest("BOS-9999: unknown", "bos-9999-x", known).length, 0);
  });

  it("links nothing when there is no identifier", () => {
    assert.equal(linkPullRequest("A tidy refactor", "main", known).length, 0);
  });
});

describe("linkCommit", () => {
  it("links a subject that names a synced issue", () => {
    const links = linkCommit("BOS-2422 fix the redirect", new Set(["BOS-2422"]));
    assert.equal(links.length, 1);
    assert.equal(links[0]?.identifier, "BOS-2422");
    assert.equal(links[0]?.via, "commit_subject");
  });

  it("ignores unknown identifiers so typos never create phantom issues", () => {
    assert.equal(linkCommit("BOS-9999 oops", new Set(["BOS-2422"])).length, 0);
  });
});
