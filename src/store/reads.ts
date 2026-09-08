/**
 * The read side of persistence.
 *
 * These functions do the filtering SQL is good at — a time range and an identity
 * match — and return rows. Bucketing by calendar day and the summary statistics
 * happen in `metrics/`, where they are timezone-aware and directly testable.
 */

import type { Identity } from "../domain/types.ts";
import type { Db } from "./db.ts";

export interface TimeRange {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface CommitRow {
  readonly repository_key: string;
  readonly repository_slug: string | null;
  readonly sha: string;
  readonly author_name: string;
  readonly author_email: string;
  readonly authored_at: string;
  readonly authored_at_ms: number;
  readonly committed_at: string;
  readonly committed_at_ms: number;
  readonly subject: string;
  readonly additions: number;
  readonly deletions: number;
  readonly files_changed: number;
  readonly excluded_additions: number;
  readonly excluded_deletions: number;
  readonly source_url: string | null;
  readonly recorded_at: string;
}

export interface PullRequestRow {
  readonly repository_key: string;
  readonly repository_slug: string | null;
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly is_draft: number;
  readonly author_login: string | null;
  readonly created_at: string;
  readonly created_at_ms: number;
  readonly merged_at: string | null;
  readonly merged_at_ms: number | null;
  readonly updated_at: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changed_files: number;
  readonly head_ref: string | null;
  readonly merge_commit_sha: string | null;
  readonly source_id: string;
  readonly source_url: string | null;
  readonly recorded_at: string;
}

export interface ReviewRow {
  readonly repository_key: string;
  readonly repository_slug: string | null;
  readonly pull_request_number: number;
  readonly pull_request_source_id: string;
  readonly state: string;
  readonly submitted_at: string;
  readonly submitted_at_ms: number;
  readonly source_id: string;
  readonly source_url: string | null;
  readonly recorded_at: string;
}

export interface LinearIssueRow {
  readonly identifier: string;
  readonly title: string;
  readonly state_name: string;
  readonly state_type: string;
  readonly created_at: string;
  readonly created_at_ms: number;
  readonly updated_at: string;
  readonly updated_at_ms: number;
  readonly completed_at: string | null;
  readonly completed_at_ms: number | null;
  readonly team_key: string | null;
  readonly source_id: string;
  readonly source_url: string | null;
  readonly recorded_at: string;
}

export interface RepositoryRow {
  readonly key: string;
  readonly local_path: string | null;
  readonly slug: string | null;
  readonly default_ref: string | null;
  readonly head_sha: string | null;
  readonly head_committed_at: string | null;
  readonly last_synced_at: string | null;
}

/** One non-merge commit, reduced to what per-day observed volume needs. */
export interface CommitDayRow {
  readonly repository_key: string;
  readonly authored_at_ms: number;
  readonly author_email: string;
}

export interface SyncRunRow {
  readonly id: number;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly status: string;
  readonly since: string;
  readonly actor_login: string | null;
  readonly notes: string | null;
}

const COMMIT_COLUMNS = `
  r.key  AS repository_key,
  r.slug AS repository_slug,
  c.sha, c.author_name, c.author_email, c.authored_at, c.authored_at_ms,
  c.committed_at, c.committed_at_ms, c.subject,
  c.additions, c.deletions, c.files_changed,
  c.excluded_additions, c.excluded_deletions, c.source_url, c.recorded_at`;

const PR_COLUMNS = `
  r.key  AS repository_key,
  r.slug AS repository_slug,
  p.number, p.title, p.state, p.is_draft, p.author_login,
  p.created_at, p.created_at_ms, p.merged_at, p.merged_at_ms, p.updated_at,
  p.additions, p.deletions, p.changed_files, p.head_ref, p.merge_commit_sha,
  p.source_id, p.source_url, p.recorded_at`;

/**
 * Non-merge commits authored by the user inside the range.
 *
 * The same commit can be reachable from an upstream repository and a configured
 * fork. Its SHA is source identity, so select one deterministic copy globally.
 */
export function readCommitsAuthored(db: Db, range: TimeRange, identity: Identity): CommitRow[] {
  if (identity.gitEmails.length === 0) return [];
  const emails = placeholders(identity.gitEmails.length);
  return db
    .prepare(
      `SELECT ${COMMIT_COLUMNS}
       FROM commit_event c JOIN repository r ON r.id = c.repository_id
       WHERE c.is_merge = 0
         AND c.authored_at_ms >= ? AND c.authored_at_ms <= ?
         AND c.author_email IN (${emails})
         AND c.repository_id = (
           SELECT MIN(copy.repository_id) FROM commit_event copy WHERE copy.sha = c.sha
         )
       ORDER BY c.authored_at_ms DESC, c.sha`,
    )
    .all(range.fromMs, range.toMs, ...identity.gitEmails) as unknown as CommitRow[];
}

/**
 * Every non-merge commit in range, by anyone, as the raw material for per-day
 * observed volume.
 *
 * Grouping happens above this call rather than in SQL because a calendar day
 * depends on the viewer's zone, which SQLite has no way to apply.
 */
export function readCommitDayRows(db: Db, range: TimeRange): CommitDayRow[] {
  return db
    .prepare(
      `SELECT r.key AS repository_key, c.authored_at_ms, c.author_email
       FROM commit_event c JOIN repository r ON r.id = c.repository_id
       WHERE c.is_merge = 0
         AND c.authored_at_ms >= ? AND c.authored_at_ms <= ?
       ORDER BY r.key, c.authored_at_ms`,
    )
    .all(range.fromMs, range.toMs) as unknown as CommitDayRow[];
}

/** Pull requests the user opened inside the range. */
export function readPullRequestsOpened(
  db: Db,
  range: TimeRange,
  identity: Identity,
): PullRequestRow[] {
  if (identity.githubLogin === null) return [];
  return db
    .prepare(
      `SELECT ${PR_COLUMNS}
       FROM pull_request p JOIN repository r ON r.id = p.repository_id
       WHERE p.author_login = ? COLLATE NOCASE
         AND p.created_at_ms >= ? AND p.created_at_ms <= ?
       ORDER BY p.created_at_ms DESC`,
    )
    .all(identity.githubLogin, range.fromMs, range.toMs) as unknown as PullRequestRow[];
}

/** Pull requests the user opened that were merged inside the range. */
export function readPullRequestsMerged(
  db: Db,
  range: TimeRange,
  identity: Identity,
): PullRequestRow[] {
  if (identity.githubLogin === null) return [];
  return db
    .prepare(
      `SELECT ${PR_COLUMNS}
       FROM pull_request p JOIN repository r ON r.id = p.repository_id
       WHERE p.author_login = ? COLLATE NOCASE
         AND p.merged_at_ms IS NOT NULL
         AND p.merged_at_ms >= ? AND p.merged_at_ms <= ?
       ORDER BY p.merged_at_ms DESC`,
    )
    .all(identity.githubLogin, range.fromMs, range.toMs) as unknown as PullRequestRow[];
}

/** Reviews the user submitted inside the range. */
export function readReviewsGiven(db: Db, range: TimeRange, identity: Identity): ReviewRow[] {
  if (identity.githubLogin === null) return [];
  return db
    .prepare(
      `SELECT r.key AS repository_key, r.slug AS repository_slug,
              v.pull_request_number, v.pull_request_source_id, v.state,
              v.submitted_at, v.submitted_at_ms, v.source_id, v.source_url, v.recorded_at
       FROM review v JOIN repository r ON r.id = v.repository_id
       WHERE v.reviewer_login = ? COLLATE NOCASE
         AND v.submitted_at_ms >= ? AND v.submitted_at_ms <= ?
       ORDER BY v.submitted_at_ms DESC`,
    )
    .all(identity.githubLogin, range.fromMs, range.toMs) as unknown as ReviewRow[];
}

/**
 * Pull requests by source id, for the ones a set of reviews points at.
 *
 * A reviewed pull request is usually somebody else's; it is read so its title can
 * be shown beside the review, and for no other metric.
 */
export function readPullRequestsById(
  db: Db,
  sourceIds: readonly string[],
): PullRequestRow[] {
  const ids = [...new Set(sourceIds)];
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT ${PR_COLUMNS}
       FROM pull_request p JOIN repository r ON r.id = p.repository_id
       WHERE p.source_id IN (${placeholders(ids.length)})
       ORDER BY r.key, p.number`,
    )
    .all(...ids) as unknown as PullRequestRow[];
}

export function readRepositories(db: Db): RepositoryRow[] {
  return db
    .prepare(
      `SELECT key, local_path, slug, default_ref, head_sha, head_committed_at, last_synced_at
       FROM repository ORDER BY key`,
    )
    .all() as unknown as RepositoryRow[];
}

export function readLastSyncRun(db: Db): SyncRunRow | null {
  const row = db
    .prepare("SELECT * FROM sync_run ORDER BY id DESC LIMIT 1")
    .get() as unknown as SyncRunRow | undefined;
  return row ?? null;
}

/**
 * Every synced Linear issue, for joining pull requests and commits against.
 * Volume is one developer's assigned issues, so a full scan is cheap and keeps
 * links consistent: a PR only counts as linked when its identifier is in this set.
 */
export function readLinearIssues(db: Db): LinearIssueRow[] {
  try {
    return db
      .prepare(
        `SELECT identifier, title, state_name, state_type,
                created_at, created_at_ms, updated_at, updated_at_ms,
                completed_at, completed_at_ms, team_key, source_id, source_url, recorded_at
         FROM linear_issue ORDER BY identifier`,
      )
      .all() as unknown as LinearIssueRow[];
  } catch {
    return [];
  }
}

/** Completed issues whose completion falls inside the dashboard window. */
export function readLinearIssuesCompleted(db: Db, range: TimeRange): LinearIssueRow[] {
  try {
    return db
      .prepare(
        `SELECT identifier, title, state_name, state_type,
                created_at, created_at_ms, updated_at, updated_at_ms,
                completed_at, completed_at_ms, team_key, source_id, source_url, recorded_at
         FROM linear_issue
         WHERE completed_at_ms IS NOT NULL
           AND completed_at_ms >= ? AND completed_at_ms <= ?
         ORDER BY completed_at_ms DESC, identifier`,
      )
      .all(range.fromMs, range.toMs) as unknown as LinearIssueRow[];
  } catch {
    return [];
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
