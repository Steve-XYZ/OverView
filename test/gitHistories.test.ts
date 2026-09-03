import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { defaultConfig, type OverviewConfig } from "../src/config/config.ts";
import { collectFromGit } from "../src/ingest/git/collect.ts";
import { sync } from "../src/ingest/sync.ts";
import { buildSummary } from "../src/metrics/summary.ts";
import { createWindow } from "../src/metrics/window.ts";
import { openDatabase } from "../src/store/db.ts";

const exec = promisify(execFile);
const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe("real Git histories", () => {
  it("uses author dates through skewed timestamps, merge commits, and squash merges", async () => {
    const repo = await createRepository();
    const recent = isoDaysAgo(2);
    const old = isoDaysAgo(400);

    await commitFile(repo, "old.txt", "old\n", "Old author, recent committer", old, recent);
    await commitFile(repo, "recent.txt", "recent\n", "Recent author, old committer", recent, old);

    await git(repo, ["checkout", "-b", "merge-topic"]);
    await commitFile(repo, "topic.txt", "topic\n", "Merge topic work", recent, recent);
    await git(repo, ["checkout", "main"]);
    await commitFile(repo, "main.txt", "main\n", "Main-side work", recent, recent);
    await git(repo, ["merge", "--no-ff", "merge-topic", "-m", "Merge topic"], recent, recent);

    await git(repo, ["checkout", "-b", "squash-topic"]);
    await commitFile(repo, "squash.txt", "source\n", "Squash source", recent, recent);
    await git(repo, ["checkout", "main"]);
    await git(repo, ["merge", "--squash", "squash-topic"]);
    await git(repo, ["commit", "-m", "Squashed change"], recent, recent);

    const collection = await collectFromGit(
      { path: repo, defaultBranch: "main" },
      {
        sinceIso: isoDaysAgo(30),
        excludePaths: [],
        fetchBeforeSync: false,
        syncRunId: 1,
      },
    );
    const subjects = collection.commits.map((commit) => commit.subject);

    assert.equal(subjects.includes("Old author, recent committer"), false);
    assert.equal(subjects.includes("Recent author, old committer"), true);
    assert.equal(subjects.includes("Squash source"), false, "unreachable pre-squash commit");
    assert.equal(subjects.includes("Squashed change"), true);
    assert.equal(collection.commits.find((commit) => commit.subject === "Merge topic")?.parentCount, 2);
    assert.notEqual(
      collection.commits.find((commit) => commit.subject === "Recent author, old committer")
        ?.authoredAt,
      collection.commits.find((commit) => commit.subject === "Recent author, old committer")
        ?.committedAt,
    );
  });

  it("reconciles a rewritten commit instead of retaining both SHAs", async () => {
    const repo = await createRepository();
    const recent = isoDaysAgo(2);
    await commitFile(repo, "work.txt", "one\n", "Original", recent, recent);

    const db = openDatabase(":memory:");
    const config = configFor([{ path: repo, defaultBranch: "main" }]);
    await sync(db, config, { skipGithub: true });
    const firstSha = (db.prepare("SELECT sha FROM commit_event").get() as { sha: string }).sha;

    await writeFile(join(repo, "work.txt"), "two\n", "utf8");
    await git(repo, ["add", "work.txt"]);
    await git(repo, ["commit", "--amend", "--no-edit"], recent, isoDaysAgo(1));
    await sync(db, config, { skipGithub: true });

    const rows = db.prepare("SELECT sha FROM commit_event").all() as unknown as { sha: string }[];
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]?.sha, firstSha);
    db.close();
  });

  it("ignores a duplicate checkout of the same GitHub repository", async () => {
    const repo = await createRepository();
    const recent = isoDaysAgo(2);
    await commitFile(repo, "work.txt", "one\n", "One change", recent, recent);
    const cloneParent = await temporaryDirectory();
    const clone = join(cloneParent, "clone");
    await exec("git", ["clone", "--quiet", repo, clone]);

    const db = openDatabase(":memory:");
    const result = await sync(
      db,
      configFor([
        { path: repo, githubRepo: "acme/widget", defaultBranch: "main" },
        { path: clone, githubRepo: "acme/widget", defaultBranch: "main" },
      ]),
      { skipGithub: true },
    );

    assert.equal(result.warnings.some((warning) => warning.includes("duplicate checkout")), true);
    assert.equal(count(db, "repository"), 1);
    assert.equal(count(db, "commit_event"), 1);
    db.close();
  });

  it("warns when a shallow checkout limits the reachable history", async () => {
    const repo = await createRepository();
    const recent = isoDaysAgo(3);
    await commitFile(repo, "one.txt", "one\n", "One", recent, recent);
    await commitFile(repo, "two.txt", "two\n", "Two", recent, recent);
    const cloneParent = await temporaryDirectory();
    const clone = join(cloneParent, "shallow");
    await exec("git", ["clone", "--quiet", "--depth=1", `file://${repo}`, clone]);

    const collection = await collectFromGit(
      { path: clone, defaultBranch: "main" },
      {
        sinceIso: isoDaysAgo(30),
        excludePaths: [],
        fetchBeforeSync: false,
        syncRunId: 1,
      },
    );

    assert.equal(collection.commits.length, 1);
    assert.equal(collection.warnings.some((warning) => warning.includes("shallow checkout")), true);
  });

  it("counts one shared SHA across configured fork slugs", async () => {
    const repo = await createRepository();
    const recent = isoDaysAgo(2);
    await commitFile(repo, "work.txt", "one\n", "Shared change", recent, recent);
    const cloneParent = await temporaryDirectory();
    const fork = join(cloneParent, "fork");
    await exec("git", ["clone", "--quiet", repo, fork]);

    const db = openDatabase(":memory:");
    await sync(
      db,
      configFor([
        { path: repo, githubRepo: "acme/widget", defaultBranch: "main" },
        { path: fork, githubRepo: "ada/widget", defaultBranch: "main" },
      ]),
      { skipGithub: true },
    );
    const summary = buildSummary(
      db,
      createWindow(30),
      { githubLogin: "ada", gitEmails: ["ada@example.com"] },
    );

    assert.equal(summary.repositories.length, 2);
    assert.equal(summary.totals.commitsAuthored, 1);
    assert.equal(summary.warnings.some((warning) => warning.includes("counted once by SHA")), true);
    db.close();
  });
});

async function createRepository(): Promise<string> {
  const path = await temporaryDirectory();
  await git(path, ["init", "--quiet", "--initial-branch=main"]);
  await git(path, ["config", "user.name", "Ada"]);
  await git(path, ["config", "user.email", "ada@example.com"]);
  return path;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "overview-git-"));
  temporaryDirectories.push(path);
  return path;
}

async function commitFile(
  repo: string,
  filename: string,
  contents: string,
  subject: string,
  authorDate: string,
  committerDate: string,
): Promise<void> {
  await writeFile(join(repo, filename), contents, "utf8");
  await git(repo, ["add", filename]);
  await git(repo, ["commit", "--quiet", "-m", subject], authorDate, committerDate);
}

async function git(
  cwd: string,
  args: readonly string[],
  authorDate?: string,
  committerDate?: string,
): Promise<void> {
  await exec("git", [...args], {
    cwd,
    env: {
      ...process.env,
      ...(authorDate === undefined ? {} : { GIT_AUTHOR_DATE: authorDate }),
      ...(committerDate === undefined ? {} : { GIT_COMMITTER_DATE: committerDate }),
    },
  });
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function configFor(repositories: OverviewConfig["repositories"]): OverviewConfig {
  return {
    ...defaultConfig(),
    identity: { githubLogin: "ada", gitEmails: ["ada@example.com"] },
    repositories,
    sync: { sinceDays: 30, fetchBeforeSync: false },
  };
}

function count(db: ReturnType<typeof openDatabase>, table: "repository" | "commit_event"): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}
