/**
 * The write side of persistence: the only place ingestion touches SQL.
 *
 * Every insert is an upsert keyed on the source's own identifier, so re-running a
 * sync over an overlapping window updates rows instead of duplicating them.
 */

import type {
  CommitRecord,
  LinearIssueRecord,
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

/** Keep the cache aligned with the repository paths in the current config. */
export function deleteRepositoriesOutsidePaths(db: Db, paths: readonly string[]): number {
  const result =
    paths.length === 0
      ? db.prepare("DELETE FROM repository").run()
      : db
          .prepare(
            `DELETE FROM repository
             WHERE local_path IS NULL OR local_path NOT IN (${paths.map(() => "?").join(", ")})`,
          )
          .run(...paths);
  return Number(result.changes);
}

/** A checkout can change remotes; one configured path must not retain two repository keys. */
export function deleteRepositoryAliases(db: Db, localPath: string, key: string): number {
  const result = db
    .prepare("DELETE FROM repository WHERE local_path = ? AND key != ?")
    .run(localPath, key);
  return Number(result.changes);
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

/** Remove recent rows that are no longer reachable after a rebase, squash, or force-push. */
export function deleteUnseenCommits(
  db: Db,
  repositoryId: number,
  sinceMs: number,
  syncRunId: number,
): number {
  const result = db
    .prepare(
      `DELETE FROM commit_event
       WHERE repository_id = ? AND authored_at_ms >= ? AND sync_run_id != ?`,
    )
    .run(repositoryId, sinceMs, syncRunId);
  return Number(result.changes);
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
       updated_at, additions, deletions, changed_files, base_ref, head_ref, merge_commit_sha,
       source_system, source_id, source_url, recorded_at, sync_run_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
       head_ref         = excluded.head_ref,
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
      pr.authorLogin?.toLowerCase() ?? null,
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
      pr.headRef,
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
      review.reviewerLogin.toLowerCase(),
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

/**
 * Linear issues are workspace-global, so there is no repository id. Upsert on
 * both the Linear UUID (`source_id`) and the human identifier (`BOS-2422`): an
 * issue keeps its UUID when it moves teams, but the identifier is the join key
 * the dashboard links on.
 */
export function upsertLinearIssues(db: Db, issues: readonly LinearIssueRecord[]): number {
  const statement = db.prepare(
    `INSERT INTO linear_issue (
       identifier, title, state_name, state_type,
       created_at, created_at_ms, updated_at, updated_at_ms,
       completed_at, completed_at_ms, team_key,
       source_system, source_id, source_url, recorded_at, sync_run_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (source_id) DO UPDATE SET
        identifier      = excluded.identifier,
        title           = excluded.title,
        state_name      = excluded.state_name,
        state_type      = excluded.state_type,
        created_at      = excluded.created_at,
        created_at_ms   = excluded.created_at_ms,
        updated_at      = excluded.updated_at,
        updated_at_ms   = excluded.updated_at_ms,
        completed_at    = excluded.completed_at,
        completed_at_ms = excluded.completed_at_ms,
        team_key        = excluded.team_key,
        source_url      = excluded.source_url,
        recorded_at     = excluded.recorded_at,
        sync_run_id     = excluded.sync_run_id`,
  );

  for (const issue of issues) {
    statement.run(
      issue.identifier.toUpperCase(),
      issue.title,
      issue.stateName,
      issue.stateType,
      toIsoUtc(issue.createdAt),
      toEpochMs(issue.createdAt),
      toIsoUtc(issue.updatedAt),
      toEpochMs(issue.updatedAt),
      issue.completedAt === null ? null : toIsoUtc(issue.completedAt),
      issue.completedAt === null ? null : toEpochMs(issue.completedAt),
      issue.teamKey,
      issue.provenance.sourceSystem,
      issue.provenance.sourceId,
      issue.provenance.sourceUrl,
      issue.provenance.recordedAt,
      issue.provenance.syncRunId,
    );
  }

  // An issue that moved teams keeps its UUID but changes identifier. The human
  // key must stay unique, so drop any stale row holding the new identifier.
  const dedupe = db.prepare(
    `DELETE FROM linear_issue
      WHERE id NOT IN (SELECT MIN(id) FROM linear_issue GROUP BY identifier)`,
  );
  dedupe.run();

  return issues.length;
}
