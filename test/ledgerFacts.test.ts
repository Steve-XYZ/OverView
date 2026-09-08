/**
 * The properties that make a fact ledger safe to compute a dashboard from.
 *
 * The central one is a commutation: redacting the facts and then summarising them
 * must give the same answer as summarising and then redacting the summary. The
 * first is what the hosted side does, the second is what the collector has always
 * done. If they agree, the hosted dashboard reproduces the local report by
 * construction rather than by two implementations happening to match.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { currentTimeZone } from "../src/domain/time.ts";
import type { ActivitySummary } from "../src/metrics/summary.ts";
import { summarize } from "../src/metrics/summary.ts";
import { createWindow } from "../src/metrics/window.ts";
import {
  buildLedgerPublication,
  coverageDays,
  isLedgerPublication,
  issuesTouchingRedactedRepositories,
  redactFacts,
  redactForPublishing,
} from "../src/publish/publish.ts";
import { collectFacts } from "../src/store/facts.ts";
import {
  LEDGER_CONFIG,
  LEDGER_IDENTITY,
  NOW,
  SECRET,
  SECRETS,
  seedLedgerDatabase,
  WIDGET,
  WORK_EMAIL,
} from "./helpers/ledgerFixture.ts";
import type { Db } from "../src/store/db.ts";

const ZONE = currentTimeZone();

/** Everything but the wall clock, which the two sides read at different moments. */
function stable(summary: ActivitySummary): unknown {
  const { generatedAt: _generatedAt, ...rest } = summary;
  return rest;
}

function coverage(db: Db): ReturnType<typeof collectFacts> {
  const window = createWindow(coverageDays(LEDGER_CONFIG), NOW, ZONE);
  return collectFacts(db, { fromMs: window.fromMs, toMs: window.toMs }, LEDGER_IDENTITY, ZONE);
}

describe("the fact ledger", () => {
  it("gives the same dashboard whether facts or the summary are redacted", () => {
    const seeded = seedLedgerDatabase();
    const facts = coverage(seeded.db);
    const redacted = redactFacts(facts, LEDGER_CONFIG);
    const protectedIssues = issuesTouchingRedactedRepositories(facts, LEDGER_CONFIG);

    for (const days of [7, 30, 90]) {
      const window = createWindow(days, NOW, ZONE);
      assert.deepEqual(
        stable(summarize(redacted, window)),
        stable(redactForPublishing(summarize(facts, window), LEDGER_CONFIG, protectedIssues)),
        `the ${days} day window disagrees`,
      );
    }
    seeded.db.close();
  });

  it("answers a range the collector never computed", () => {
    const seeded = seedLedgerDatabase();
    const wide = redactFacts(coverage(seeded.db), LEDGER_CONFIG);

    // 14 days is not one of the published windows, so nothing about it was decided
    // at publication time; it has to fall out of the records alone.
    const window = createWindow(14, NOW, ZONE);
    const narrow = redactFacts(
      collectFacts(
        seeded.db,
        { fromMs: window.fromMs, toMs: window.toMs },
        LEDGER_IDENTITY,
        ZONE,
      ),
      LEDGER_CONFIG,
    );

    assert.deepEqual(stable(summarize(wide, window)), stable(summarize(narrow, window)));
    seeded.db.close();
  });

  it("counts a commit once but reports the duplicate copy it found", () => {
    const seeded = seedLedgerDatabase();
    const window = createWindow(7, NOW, ZONE);
    const summary = summarize(redactFacts(coverage(seeded.db), LEDGER_CONFIG), window);

    const shas = summary.recentCommits.map((entry) => entry.sha);
    assert.equal(shas.filter((sha) => sha === "dupe01").length, 1);
    assert.equal(
      summary.warnings.some((warning) => warning.includes("duplicate commit copy was found")),
      true,
      summary.warnings.join(" | "),
    );
    seeded.db.close();
  });

  it("links a squash commit through its pull request and nothing else", () => {
    const seeded = seedLedgerDatabase();
    const facts = redactFacts(coverage(seeded.db), LEDGER_CONFIG);

    // Only subject evidence is published; the squash commit's subject names no issue.
    assert.deepEqual(
      facts.commitLinks.filter((link) => link.sha === "merge7"),
      [],
    );
    const issue = summarize(facts, createWindow(7, NOW, ZONE)).linear.completedIssues.find(
      (entry) => entry.identifier === "BOS-77",
    );
    assert.deepEqual(
      issue?.commits.map((entry) => [entry.sha, entry.via]),
      [["merge7", "pr_merge_commit"]],
    );

    // Outside the window that landed the pull request, the derived link is gone.
    const older = summarize(facts, createWindow(90, NOW, ZONE)).linear.completedIssues.find(
      (entry) => entry.identifier === "BOS-99",
    );
    assert.deepEqual(older?.commits, []);
    seeded.db.close();
  });

  it("strips every redacted detail from the records before they are serialized", () => {
    const seeded = seedLedgerDatabase();
    const publication = buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW);
    const wire = JSON.stringify(publication);

    for (const secret of SECRETS) {
      assert.equal(wire.includes(secret), false, `published payload leaked ${secret}`);
    }

    // What survives: the repository identity, the numbers, and the identifiers a
    // reader needs to check a figure by hand.
    assert.equal(wire.includes("company/secret"), true);
    const secretCommit = publication.facts.commits.find((fact) => fact.sha === "merge7");
    assert.equal(secretCommit?.repositoryKey, SECRET);
    assert.equal(secretCommit?.subject, "");
    assert.equal(secretCommit?.sourceUrl, null);
    assert.equal(secretCommit?.additions, 10);

    const secretPullRequest = publication.facts.pullRequests.find((fact) => fact.number === 7);
    assert.equal(secretPullRequest?.title, "");
    assert.equal(secretPullRequest?.sourceUrl, null);
    assert.equal(secretPullRequest?.mergeCommitSha, "merge7");

    const secretIssue = publication.facts.linearIssues.find((fact) => fact.identifier === "BOS-77");
    assert.equal(secretIssue?.title, "");
    assert.equal(secretIssue?.sourceUrl, null);
    assert.equal(secretIssue?.stateName, "Done");

    // A detailed repository keeps its detail, including the addresses it observed.
    const widgetIssue = publication.facts.linearIssues.find((fact) => fact.identifier === "BOS-42");
    assert.equal(widgetIssue?.title, "Add the widget");
    const widgetDay = publication.facts.repositoryDays.find((fact) => fact.repositoryKey === WIDGET);
    assert.deepEqual(widgetDay?.authorEmails, ["ada@example.com"]);
    const secretDay = publication.facts.repositoryDays.find((fact) => fact.repositoryKey === SECRET);
    assert.deepEqual(secretDay?.authorEmails, []);
    assert.equal((secretDay?.commitsObserved ?? 0) > 0, true);

    // Identity addresses never travel, and a path-only checkout publishes an alias.
    assert.deepEqual(publication.facts.collector.identity.gitEmails, []);
    assert.equal(publication.facts.collector.identity.gitEmailsConfigured, true);
    assert.equal(wire.includes(WORK_EMAIL), false);
    assert.equal(
      publication.facts.repositories.some((repo) => repo.key === "local-repository-3"),
      true,
    );
    assert.equal(publication.facts.repositories.every((repo) => repo.localPath === null), true);
    seeded.db.close();
  });

  it("keeps a redacted repository's issue title out of every window", () => {
    const seeded = seedLedgerDatabase();
    const facts = coverage(seeded.db);
    const protectedIssues = issuesTouchingRedactedRepositories(facts, LEDGER_CONFIG);
    assert.equal(protectedIssues.has("BOS-77"), true);
    assert.equal(protectedIssues.has("BOS-42"), false);

    // BOS-77 completed inside the 7 day window, where its redacted pull request is
    // visible, and inside the 90 day window, where the merge is older than the
    // window's other work. The rule is decided once, so both are blank.
    for (const days of [7, 30, 90]) {
      const summary = summarize(redactFacts(facts, LEDGER_CONFIG), createWindow(days, NOW, ZONE));
      const issue = summary.linear.completedIssues.find((entry) => entry.identifier === "BOS-77");
      if (issue !== undefined) assert.equal(issue.title, "");
    }
    seeded.db.close();
  });

  it("accepts its own publication and rejects a tampered one", () => {
    const seeded = seedLedgerDatabase();
    const publication = buildLedgerPublication(seeded.db, LEDGER_CONFIG, NOW);
    assert.equal(isLedgerPublication(publication), true);

    const roundTripped: unknown = JSON.parse(JSON.stringify(publication));
    assert.equal(isLedgerPublication(roundTripped), true);

    assert.equal(
      isLedgerPublication({
        ...publication,
        facts: {
          ...publication.facts,
          commits: publication.facts.commits.slice(1),
        },
      }),
      false,
      "a spliced record set must not match the content id",
    );
    assert.equal(
      isLedgerPublication({ ...publication, token: "must-not-be-accepted" }),
      false,
    );
    assert.equal(
      isLedgerPublication({
        ...publication,
        facts: {
          ...publication.facts,
          repositories: publication.facts.repositories.map((repo) => ({
            ...repo,
            localPath: "/src/secret",
          })),
        },
      }),
      false,
      "a local path in a repository record must be refused",
    );
    assert.equal(
      isLedgerPublication({
        ...publication,
        facts: {
          ...publication.facts,
          commitLinks: [
            { repositoryKey: WIDGET, sha: "widget01", issueIdentifier: "BOS-42", via: "pr_merge_commit" },
          ],
        },
      }),
      false,
      "derived link evidence must not be publishable",
    );
    seeded.db.close();
  });
});
