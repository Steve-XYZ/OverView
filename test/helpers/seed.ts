/** Fixture builders for the store, so metric tests read as data rather than SQL. */

import type {
  CommitRecord,
  Identity,
  LinearIssueRecord,
  Provenance,
  PullRequestRecord,
  RepositoryRecord,
  ReviewRecord,
} from "../../src/domain/types.ts";
import { openDatabase, type Db } from "../../src/store/db.ts";
import {
  startSyncRun,
  upsertCommits,
  upsertLinearIssues,
  upsertPullRequests,
  upsertRepository,
  upsertReviews,
} from "../../src/store/writes.ts";

export const REPO_KEY = "github:acme/widget";

export const IDENTITY: Identity = {
  githubLogin: "ada",
  gitEmails: ["ada@example.com"],
};

export const REPOSITORY: RepositoryRecord = {
  key: REPO_KEY,
  localPath: "/src/widget",
  provider: "github",
  slug: "acme/widget",
  defaultBranch: "main",
  defaultRef: "origin/main",
  headSha: "head0000",
  headCommittedAt: "2026-09-03T10:00:00.000Z",
};

export function provenance(sourceId: string, syncRunId: number): Provenance {
  return {
    sourceSystem: "github",
    sourceId,
    sourceUrl: `https://example.invalid/${sourceId}`,
    recordedAt: "2026-09-03T12:00:00.000Z",
    syncRunId,
  };
}

export function commit(options: {
  sha: string;
  email?: string;
  authoredAt: string;
  committedAt?: string;
  additions?: number;
  deletions?: number;
  files?: number;
  parents?: number;
  syncRunId: number;
}): CommitRecord {
  return {
    repositoryKey: REPO_KEY,
    sha: options.sha,
    authorName: "Ada",
    authorEmail: options.email ?? "ada@example.com",
    authoredAt: options.authoredAt,
    committerName: "Ada",
    committerEmail: options.email ?? "ada@example.com",
    committedAt: options.committedAt ?? options.authoredAt,
    subject: `Commit ${options.sha}`,
    parentCount: options.parents ?? 1,
    diff: {
      additions: options.additions ?? 10,
      deletions: options.deletions ?? 2,
      filesChanged: options.files ?? 1,
      excludedAdditions: 0,
      excludedDeletions: 0,
      excludedFiles: 0,
      binaryFiles: 0,
    },
    ref: "origin/main",
    provenance: {
      sourceSystem: "git",
      sourceId: options.sha,
      sourceUrl: `https://example.invalid/commit/${options.sha}`,
      recordedAt: "2026-09-03T12:00:00.000Z",
      syncRunId: options.syncRunId,
    },
  };
}

export function pullRequest(options: {
  id: string;
  number: number;
  login?: string;
  title?: string;
  createdAt: string;
  mergedAt?: string;
  headRef?: string | null;
  mergeCommitSha?: string | null;
  syncRunId: number;
}): PullRequestRecord {
  const merged = options.mergedAt !== undefined;
  return {
    repositoryKey: REPO_KEY,
    number: options.number,
    title: options.title ?? `Pull request ${options.number}`,
    state: merged ? "MERGED" : "OPEN",
    isDraft: false,
    authorLogin: options.login ?? "ada",
    createdAt: options.createdAt,
    mergedAt: options.mergedAt ?? null,
    closedAt: options.mergedAt ?? null,
    updatedAt: options.mergedAt ?? options.createdAt,
    additions: 40,
    deletions: 5,
    changedFiles: 3,
    baseRef: "main",
    headRef: options.headRef ?? null,
    mergeCommitSha:
      options.mergeCommitSha !== undefined
        ? options.mergeCommitSha
        : merged
          ? `merge${options.number}`
          : null,
    provenance: provenance(options.id, options.syncRunId),
  };
}

export function review(options: {
  id: string;
  prId: string;
  number: number;
  login?: string;
  submittedAt: string;
  syncRunId: number;
}): ReviewRecord {
  return {
    repositoryKey: REPO_KEY,
    pullRequestSourceId: options.prId,
    pullRequestNumber: options.number,
    reviewerLogin: options.login ?? "ada",
    state: "APPROVED",
    submittedAt: options.submittedAt,
    provenance: provenance(options.id, options.syncRunId),
  };
}

export function linearIssue(options: {
  id: string;
  identifier: string;
  title?: string;
  stateName?: string;
  stateType?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  teamKey?: string | null;
  syncRunId: number;
}): LinearIssueRecord {
  const completed = options.completedAt ?? null;
  return {
    identifier: options.identifier.toUpperCase(),
    title: options.title ?? `Issue ${options.identifier}`,
    stateName: options.stateName ?? (completed === null ? "In Progress" : "Done"),
    stateType: options.stateType ?? (completed === null ? "started" : "completed"),
    createdAt: options.createdAt ?? "2026-08-01T00:00:00Z",
    updatedAt: options.updatedAt ?? completed ?? "2026-09-01T00:00:00Z",
    completedAt: completed,
    teamKey: options.teamKey ?? "BOS",
    provenance: {
      sourceSystem: "linear",
      sourceId: options.id,
      sourceUrl: `https://linear.app/acme/issue/${options.identifier}`,
      recordedAt: "2026-09-03T12:00:00.000Z",
      syncRunId: options.syncRunId,
    },
  };
}

export interface SeededDb {
  readonly db: Db;
  readonly syncRunId: number;
  readonly repositoryId: number;
}

export function seedDatabase(): SeededDb {
  const db = openDatabase(":memory:");
  const syncRunId = startSyncRun(db, "2026-06-01T00:00:00.000Z", "ada");
  const repositoryId = upsertRepository(db, REPOSITORY);
  return { db, syncRunId, repositoryId };
}

export function writeAll(
  seeded: SeededDb,
  data: {
    commits?: CommitRecord[];
    pullRequests?: PullRequestRecord[];
    reviews?: ReviewRecord[];
    linearIssues?: LinearIssueRecord[];
  },
): void {
  upsertCommits(seeded.db, seeded.repositoryId, data.commits ?? []);
  upsertPullRequests(seeded.db, seeded.repositoryId, data.pullRequests ?? []);
  upsertReviews(seeded.db, seeded.repositoryId, data.reviews ?? []);
  upsertLinearIssues(seeded.db, data.linearIssues ?? []);
}
