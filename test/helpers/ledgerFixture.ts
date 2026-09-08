/**
 * One database that exercises every rule the publication contract has to preserve:
 * a detailed repository, a redacted one, a path-only checkout with no remote, a
 * commit present in two repositories, a review on somebody else's pull request, a
 * squash commit that only inherits its issue through its pull request, and Linear
 * issues on both sides of the redaction rule.
 *
 * Records are placed relative to `NOW` rather than on fixed calendar dates so the
 * windows they fall in do not depend on the zone the tests run in.
 */

import type { OverviewConfig } from "../../src/config/config.ts";
import { defaultConfig } from "../../src/config/config.ts";
import { MS_PER_DAY } from "../../src/domain/time.ts";
import type { Identity, RepositoryRecord } from "../../src/domain/types.ts";
import { addRepository, commit, linearIssue, pullRequest, review, seedDatabase, writeAll, type SeededDb } from "./seed.ts";

export const NOW = Date.parse("2026-09-03T12:00:00.000Z");

export const WIDGET = "github:acme/widget";
export const SECRET = "github:company/secret";
export const LOCAL = "path:/src/local-thing";

/** Only ever seen in the redacted repository, so its absence is a real assertion. */
export const WORK_EMAIL = "ada@work.example";
export const HOME_EMAIL = "ada@example.com";

export const LEDGER_IDENTITY: Identity = {
  githubLogin: "ada",
  gitEmails: [HOME_EMAIL, WORK_EMAIL],
};

export const LEDGER_CONFIG: OverviewConfig = {
  ...defaultConfig(),
  identity: LEDGER_IDENTITY,
  repositories: [
    { path: "/src/widget", githubRepo: "acme/widget" },
    { path: "/src/secret", githubRepo: "company/secret", hostedDetail: "redacted" },
    { path: "/src/local-thing" },
  ],
  publish: { endpoint: "https://overview.example/api/publish", redactLinearDetails: false },
};

/** Strings that must never reach the hosted store. */
export const SECRETS = [
  "/src/secret",
  "/src/widget",
  "/src/local-thing",
  "Rework the pricing engine",
  "BOS-77 rewrite the pricing engine",
  "Confidential pricing rewrite",
  "https://example.invalid/secret",
  WORK_EMAIL,
] as const;

const SECRET_REPOSITORY: RepositoryRecord = {
  key: SECRET,
  localPath: "/src/secret",
  provider: "github",
  slug: "company/secret",
  defaultBranch: "main",
  defaultRef: "origin/main",
  headSha: "secrethead",
  headCommittedAt: "2026-09-03T09:00:00.000Z",
};

const LOCAL_REPOSITORY: RepositoryRecord = {
  key: LOCAL,
  localPath: "/src/local-thing",
  provider: null,
  slug: null,
  defaultBranch: "main",
  defaultRef: "main",
  headSha: "localhead",
  headCommittedAt: "2026-09-02T09:00:00.000Z",
};

function at(daysAgo: number): string {
  return new Date(NOW - daysAgo * MS_PER_DAY).toISOString();
}

export function seedLedgerDatabase(): SeededDb {
  const seeded = seedDatabase();
  addRepository(seeded, SECRET_REPOSITORY);
  addRepository(seeded, LOCAL_REPOSITORY);
  const syncRunId = seeded.syncRunId;

  writeAll(seeded, {
    commits: [
      commit({ sha: "widget01", authoredAt: at(1), syncRunId }),
      commit({ sha: "widget02", authoredAt: at(3), additions: 40, deletions: 9, syncRunId }),
      commit({ sha: "widget03", authoredAt: at(20), syncRunId }),
      commit({ sha: "widget04", authoredAt: at(60), syncRunId }),
      // Names its issue in the subject, from the detailed repository.
      commit({ sha: "widget05", subject: "BOS-42 add the widget", authoredAt: at(2), syncRunId }),
      // The squash commit of the redacted repository's pull request: its subject
      // does not name the issue, so it can only link through that pull request.
      commit({
        sha: "merge7",
        subject: "Rework the pricing engine",
        authoredAt: at(1),
        email: WORK_EMAIL,
        repo: SECRET,
        syncRunId,
      }),
      commit({
        sha: "secret02",
        subject: "BOS-77 rewrite the pricing engine",
        authoredAt: at(25),
        email: WORK_EMAIL,
        repo: SECRET,
        syncRunId,
      }),
      // The same commit reachable from two configured repositories.
      commit({ sha: "dupe01", authoredAt: at(4), syncRunId }),
      commit({ sha: "dupe01", authoredAt: at(4), repo: SECRET, email: WORK_EMAIL, syncRunId }),
      commit({ sha: "local01", authoredAt: at(5), repo: LOCAL, syncRunId }),
    ],
    pullRequests: [
      pullRequest({
        id: "pr-widget-10",
        number: 10,
        title: "BOS-42 add the widget",
        headRef: "bos-42-add-the-widget",
        createdAt: at(5),
        mergedAt: at(2),
        mergeCommitSha: "widget05",
        syncRunId,
      }),
      pullRequest({
        id: "pr-secret-7",
        number: 7,
        title: "BOS-77 rewrite the pricing engine",
        headRef: "bos-77-pricing",
        createdAt: at(6),
        mergedAt: at(1),
        mergeCommitSha: "merge7",
        repo: SECRET,
        syncRunId,
      }),
      // Somebody else's pull request, stored because it was reviewed.
      pullRequest({
        id: "pr-widget-11",
        number: 11,
        login: "grace",
        title: "Tidy the build",
        createdAt: at(8),
        syncRunId,
      }),
      // Opened inside the window but not merged, so it counts as opened only.
      pullRequest({ id: "pr-widget-12", number: 12, title: "Draft work", createdAt: at(3), syncRunId }),
    ],
    reviews: [
      review({ id: "review-1", prId: "pr-widget-11", number: 11, submittedAt: at(2), syncRunId }),
      review({ id: "review-2", prId: "pr-widget-11", number: 11, submittedAt: at(1), syncRunId }),
    ],
    linearIssues: [
      linearIssue({ id: "issue-42", identifier: "BOS-42", title: "Add the widget", completedAt: at(2), syncRunId }),
      // Linked only to the redacted repository, so its title must not be published.
      linearIssue({
        id: "issue-77",
        identifier: "BOS-77",
        title: "Confidential pricing rewrite",
        completedAt: at(1),
        syncRunId,
      }),
      linearIssue({ id: "issue-99", identifier: "BOS-99", title: "Older work", completedAt: at(40), syncRunId }),
    ],
  });

  return seeded;
}
