import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseGitLog, RECORD_SEPARATOR, UNIT_SEPARATOR } from "../src/ingest/git/parseLog.ts";

const RS = RECORD_SEPARATOR;
const US = UNIT_SEPARATOR;

function commit(fields: string[], numstat: string[] = []): string {
  return `${RS}${fields.join(US)}\n\n${numstat.join("\n")}\n`;
}

const EXCLUDES = ["**/package-lock.json", "**/dist/**"];

describe("parseGitLog", () => {
  it("reads one commit with its diff volume", () => {
    const stdout = commit(
      [
        "abc123",
        "Ada Lovelace",
        "ada@example.com",
        "2026-08-01T09:15:00+02:00",
        "Ada Lovelace",
        "ada@example.com",
        "2026-08-02T11:00:00+02:00",
        "parent1",
        "Teach the engine to count",
      ],
      ["12\t3\tsrc/engine.ts", "4\t0\tsrc/engine.test.ts"],
    );

    const [parsed] = parseGitLog(stdout, EXCLUDES);
    assert.ok(parsed);
    assert.equal(parsed.sha, "abc123");
    assert.equal(parsed.authorEmail, "ada@example.com");
    assert.equal(parsed.subject, "Teach the engine to count");
    assert.equal(parsed.parentCount, 1);
    assert.equal(parsed.diff.additions, 16);
    assert.equal(parsed.diff.deletions, 3);
    assert.equal(parsed.diff.filesChanged, 2);
  });

  it("tallies excluded paths separately instead of dropping them", () => {
    const stdout = commit(
      [
        "def456",
        "Ada",
        "ada@example.com",
        "2026-08-01T09:15:00Z",
        "Ada",
        "ada@example.com",
        "2026-08-01T09:15:00Z",
        "p1",
        "Bump dependencies",
      ],
      ["3\t1\tpackage.json", "5000\t4800\tpackage-lock.json", "10\t0\tdist/bundle.js"],
    );

    const [parsed] = parseGitLog(stdout, EXCLUDES);
    assert.ok(parsed);
    assert.equal(parsed.diff.additions, 3, "only the hand-written file counts");
    assert.equal(parsed.diff.deletions, 1);
    assert.equal(parsed.diff.filesChanged, 1);
    assert.equal(parsed.diff.excludedAdditions, 5010);
    assert.equal(parsed.diff.excludedDeletions, 4800);
    assert.equal(parsed.diff.excludedFiles, 2);
  });

  it("counts binary files as touched but contributes no lines", () => {
    const stdout = commit(
      [
        "bin001",
        "Ada",
        "ada@example.com",
        "2026-08-01T00:00:00Z",
        "Ada",
        "ada@example.com",
        "2026-08-01T00:00:00Z",
        "p1",
        "Add a logo",
      ],
      ["-\t-\tassets/logo.png", "2\t0\tREADME.md"],
    );

    const [parsed] = parseGitLog(stdout, EXCLUDES);
    assert.ok(parsed);
    assert.equal(parsed.diff.additions, 2);
    assert.equal(parsed.diff.binaryFiles, 1);
    assert.equal(parsed.diff.filesChanged, 2);
  });

  it("judges a rename by where the file ended up", () => {
    const stdout = commit(
      [
        "ren001",
        "Ada",
        "ada@example.com",
        "2026-08-01T00:00:00Z",
        "Ada",
        "ada@example.com",
        "2026-08-01T00:00:00Z",
        "p1",
        "Move the bundle",
      ],
      ["0\t0\tsrc/{app => dist}/bundle.js", "1\t1\tsrc/index.ts"],
    );

    const [parsed] = parseGitLog(stdout, EXCLUDES);
    assert.ok(parsed);
    assert.equal(parsed.diff.excludedFiles, 1, "the destination is inside dist/");
    assert.equal(parsed.diff.filesChanged, 1);
  });

  it("marks merge commits by parent count and survives an empty diff", () => {
    const stdout = commit([
      "mrg001",
      "Ada",
      "ada@example.com",
      "2026-08-01T00:00:00Z",
      "Ada",
      "ada@example.com",
      "2026-08-01T00:00:00Z",
      "p1 p2",
      "Merge branch 'topic'",
    ]);

    const [parsed] = parseGitLog(stdout, EXCLUDES);
    assert.ok(parsed);
    assert.equal(parsed.parentCount, 2);
    assert.equal(parsed.diff.filesChanged, 0);
  });

  it("keeps a subject that contains a tab or a separator-like character", () => {
    const stdout = commit([
      "sub001",
      "Ada",
      "ada@example.com",
      "2026-08-01T00:00:00Z",
      "Ada",
      "ada@example.com",
      "2026-08-01T00:00:00Z",
      "p1",
      "fix: handle a\ttab in the title",
    ]);

    const [parsed] = parseGitLog(stdout, EXCLUDES);
    assert.ok(parsed);
    assert.equal(parsed.subject, "fix: handle a\ttab in the title");
  });

  it("returns nothing for empty output", () => {
    assert.deepEqual(parseGitLog("", EXCLUDES), []);
    assert.deepEqual(parseGitLog("\n\n", EXCLUDES), []);
  });

  it("reads every commit in a multi-commit log", () => {
    const stdout =
      commit(
        ["a", "A", "a@x", "2026-08-01T00:00:00Z", "A", "a@x", "2026-08-01T00:00:00Z", "p", "one"],
        ["1\t0\ta.ts"],
      ) +
      commit(
        ["b", "B", "b@x", "2026-08-02T00:00:00Z", "B", "b@x", "2026-08-02T00:00:00Z", "p", "two"],
        ["2\t0\tb.ts"],
      );

    const parsed = parseGitLog(stdout, EXCLUDES);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed.map((c) => c.sha), ["a", "b"]);
  });
});
