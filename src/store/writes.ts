/**
 * The write side of persistence: the only place ingestion touches SQL.
 *
 * Every insert is an upsert keyed on the source's own identifier, so re-running a
 * sync over an overlapping window updates rows instead of duplicating them.
 */

import type {
  CommitRecord,
  PullRequestRecord,
  RepositoryRecord,
  ReviewRecord,
  SyncStatus,
} from "../domain/types.ts";
import { toEpochMs, toIsoUtc } from "../domain/time.ts";
import type { Db } from "./db.ts";

export function startSyncRun(db: Db, since: string, actorLogin: string | null): number {
  const result = db
    .prepare(
      `INSERT INTO sync_run (started_at, status, since, actor_login)
       VALUES (?, 'running', ?, ?)`,
    )
    .run(new Date().toISOString(), since, actorLogin);
  return Number(result.lastInsertRowid);
}

export function finishSyncRun(db: Db, id: number, status: SyncStatus, notes: string): void {
  db.prepare("UPDATE sync_run SET finished_at = ?, status = ?, notes = ? WHERE id = ?").run(
    new Date().toISOString(),
    status,
    notes,
    id,
  );
}

/** Insert or update the repository row, returning its numeric id. */
export function upsertRepository(db: Db, repo: RepositoryRecord): number {
  db.prepare(
    `INSERT INTO repository (key, local_path, provider, slug, default_branch, default_ref,
                             head_sha, head_committed_at, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET
       local_path        = excluded.local_path,
       provider          = excluded.provider,
       slug              = excluded.slug,
       default_branch    = excluded.default_branch,
       default_ref       = excluded.default_ref,
       head_sha          = excluded.head_sha,
       head_committed_at = excluded.head_committed_at,
       last_synced_at    = excluded.last_synced_at`,
  ).run(
    repo.key,
    repo.localPath,
    repo.provider,
    repo.slug,
    repo.defaultBranch,
    repo.defaultRef,
    repo.headSha,
    repo.headCommittedAt,
    new Date().toISOString(),
  );
  return repositoryId(db, repo.key);
}

export function repositoryId(db: Db, key: string): number {
  const row = db.prepare("SELECT id FROM repository WHERE key = ?").get(key) as
    | { id: number }
    | undefined;
  if (row === undefined) throw new Error(`Repository not stored: ${key}`);
  return Number(row.id);
}

export function upsertCommits(db: Db, repositoryId: number, commits: readonly CommitRecord[]): number {
  const statement = db.prepare(
    `INSERT INTO commit_event (
       repository_id, sha, author_name, author_email, authored_at, authored_at_ms,
       committer_name, committer_email, committed_at, committed_at_ms, subject,
       parent_count, is_merge, additions, deletions, files_changed,
       excluded_additions, excluded_deletions, excluded_files, binary_files, ref,
       source_system, source_id, source_url, recorded_at, sync_run_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (repository_id, sha) DO UPDATE SET
       author_name        = excluded.author_name,
       author_email       = excluded.author_email,
       authored_at        = excluded.authored_at,
       authored_at_ms     = excluded.authored_at_ms,
       committer_name     = excluded.committer_name,
       committer_email    = excluded.committer_email,
       committed_at       = excluded.committed_at,
       committed_at_ms    = excluded.committed_at_ms,
       subject            = excluded.subject,
       parent_count       = excluded.parent_count,
       is_merge           = excluded.is_merge,
       additions          = excluded.additions,
       deletions          = excluded.deletions,
       files_changed      = excluded.files_changed,
       excluded_additions = excluded.excluded_additions,
       excluded_deletions = excluded.excluded_deletions,
       excluded_files     = excluded.excluded_files,
       binary_files       = excluded.binary_files,
       ref                = excluded.ref,
       source_url         = excluded.source_url,
       recorded_at        = excluded.recorded_at,
       sync_run_id        = excluded.sync_run_id`,
  );

  for (const commit of commits) {
    statement.run(
      repositoryId,
      commit.sha,
      commit.authorName,
      commit.authorEmail.toLowerCase(),
      toIsoUtc(commit.authoredAt),
      toEpochMs(commit.authoredAt),
      commit.committerName,
      commit.committerEmail.toLowerCase(),
      toIsoUtc(commit.committedAt),
      toEpochMs(commit.committedAt),
      commit.subject,
      commit.parentCount,
      commit.parentCount > 1 ? 1 : 0,
      commit.diff.additions,
      commit.diff.deletions,
      commit.diff.filesChanged,
      commit.diff.excludedAdditions,
      commit.diff.excludedDeletions,
      commit.diff.excludedFiles,
      commit.diff.binaryFiles,
      commit.ref,
      commit.provenance.sourceSystem,
      commit.provenance.sourceId,
      commit.provenance.sourceUrl,
      commit.provenance.recordedAt,
      commit.provenance.syncRunId,
    );
  }
  return commits.length;
}

export function upsertPullRequests(
  db: Db,
  repositoryId: number,
  pullRequests: readonly PullRequestRecord[],
): number {
  const statement = db.prepare(
    `INSERT INTO pull_request (
       repository_id, number, title, state, is_draft, author_login,
       created_at, created_at_ms, merged_at, merged_at_ms, closed_at, closed_at_ms,
       updated_at, additions, deletions, changed_files, base_ref, merge_commit_sha,
       source_system, source_id, source_url, recorded_at, sync_run_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (source_id) DO UPDATE SET
       repository_id    = excluded.repository_id,
       number           = excluded.number,
       title            = excluded.title,
       state            = excluded.state,
       is_draft         = excluded.is_draft,
       author_login     = excluded.author_login,
       created_at       = excluded.created_at,
       created_at_ms    = excluded.created_at_ms,
       merged_at        = excluded.merged_at,
       merged_at_ms     = excluded.merged_at_ms,
       closed_at        = excluded.closed_at,
       closed_at_ms     = excluded.closed_at_ms,
       updated_at       = excluded.updated_at,
       additions        = excluded.additions,
       deletions        = excluded.deletions,
       changed_files    = excluded.changed_files,
       base_ref         = excluded.base_ref,
       merge_commit_sha = excluded.merge_commit_sha,
       source_url       = excluded.source_url,
       recorded_at      = excluded.recorded_at,
       sync_run_id      = excluded.sync_run_id`,
  );

  for (const pr of pullRequests) {
    statement.run(
      repositoryId,
      pr.number,
      pr.title,
      pr.state,
      pr.isDraft ? 1 : 0,
      pr.authorLogin,
      toIsoUtc(pr.createdAt),
      toEpochMs(pr.createdAt),
      pr.mergedAt === null ? null : toIsoUtc(pr.mergedAt),
      pr.mergedAt === null ? null : toEpochMs(pr.mergedAt),
      pr.closedAt === null ? null : toIsoUtc(pr.closedAt),
      pr.closedAt === null ? null : toEpochMs(pr.closedAt),
      toIsoUtc(pr.updatedAt),
      pr.additions,
      pr.deletions,
      pr.changedFiles,
      pr.baseRef,
      pr.mergeCommitSha,
      pr.provenance.sourceSystem,
      pr.provenance.sourceId,
      pr.provenance.sourceUrl,
      pr.provenance.recordedAt,
      pr.provenance.syncRunId,
    );
  }
  return pullRequests.length;
}

export function upsertReviews(db: Db, repositoryId: number, reviews: readonly ReviewRecord[]): number {
  const statement = db.prepare(
    `INSERT INTO review (
       repository_id, pull_request_source_id, pull_request_number, reviewer_login,
       state, submitted_at, submitted_at_ms,
       source_system, source_id, source_url, recorded_at, sync_run_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (source_id) DO UPDATE SET
       repository_id          = excluded.repository_id,
       pull_request_source_id = excluded.pull_request_source_id,
       pull_request_number    = excluded.pull_request_number,
       reviewer_login         = excluded.reviewer_login,
       state                  = excluded.state,
       submitted_at           = excluded.submitted_at,
       submitted_at_ms        = excluded.submitted_at_ms,
       source_url             = excluded.source_url,
       recorded_at            = excluded.recorded_at,
       sync_run_id            = excluded.sync_run_id`,
  );

  for (const review of reviews) {
    statement.run(
      repositoryId,
      review.pullRequestSourceId,
      review.pullRequestNumber,
      review.reviewerLogin,
      review.state,
      toIsoUtc(review.submittedAt),
      toEpochMs(review.submittedAt),
      review.provenance.sourceSystem,
      review.provenance.sourceId,
      review.provenance.sourceUrl,
      review.provenance.recordedAt,
      review.provenance.syncRunId,
    );
  }
  return reviews.length;
}
