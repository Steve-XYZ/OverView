/**
 * The metric queries.
 *
 * This module owns every definition the dashboard shows. Each number is derived
 * from rows the store returns, and each row carries the source id and URL it came
 * from, so `definitions` below plus the tables underneath the chart are enough to
 * check any figure by hand.
 */

import type { Identity } from "../domain/types.ts";
import { MS_PER_HOUR, localDayKey } from "../domain/time.ts";
import type { Db } from "../store/db.ts";
import {
  readCommitsAuthored,
  readLastSyncRun,
  readPullRequestTitles,
  readPullRequestsMerged,
  readPullRequestsOpened,
  readRepositoryCommitScope,
  readRepositories,
  readReviewsGiven,
} from "../store/reads.ts";
import { maxOf, median, minOf, percentile, sum } from "./stats.ts";
import type { MetricWindow } from "./window.ts";

export interface DailyBucket {
  readonly date: string;
  readonly commitsAuthored: number;
  readonly pullRequestsMerged: number;
  readonly reviewsGiven: number;
}

export interface LandedPullRequest {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly mergedAt: string;
  readonly mergeHours: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly url: string | null;
}

export interface CommitEntry {
  readonly repository: string;
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly committedAt: string;
  readonly authoredAt: string;
  readonly additions: number;
  readonly deletions: number;
  readonly url: string | null;
}

export interface ReviewEntry {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly title: string;
  readonly state: string;
  readonly submittedAt: string;
  readonly url: string | null;
}

export interface RepositoryStatus {
  readonly key: string;
  readonly slug: string | null;
  readonly localPath: string | null;
  readonly defaultRef: string | null;
  readonly headSha: string | null;
  readonly headCommittedAt: string | null;
  readonly lastSyncedAt: string | null;
  readonly commitsAuthored: number;
  readonly commitsObserved: number;
  readonly authorEmails: readonly string[];
  readonly pullRequestsMerged: number;
}

export interface ActivitySummary {
  readonly generatedAt: string;
  readonly window: {
    readonly days: number;
    readonly startDay: string;
    readonly endDay: string;
    readonly startIso: string;
    readonly endIso: string;
    readonly timeZone: string;
  };
  readonly identity: { readonly githubLogin: string | null; readonly gitEmails: readonly string[] };
  readonly totals: {
    readonly commitsAuthored: number;
    readonly pullRequestsOpened: number;
    readonly pullRequestsMerged: number;
    readonly reviewsGiven: number;
    readonly pullRequestsReviewed: number;
    readonly activeDays: number;
    readonly additions: number;
    readonly deletions: number;
    readonly filesChanged: number;
    readonly excludedAdditions: number;
    readonly excludedDeletions: number;
  };
  readonly mergeTimeHours: {
    readonly count: number;
    readonly median: number | null;
    readonly p75: number | null;
    readonly fastest: number | null;
    readonly slowest: number | null;
  };
  readonly daily: readonly DailyBucket[];
  readonly landedPullRequests: readonly LandedPullRequest[];
  readonly recentCommits: readonly CommitEntry[];
  readonly recentReviews: readonly ReviewEntry[];
  readonly repositories: readonly RepositoryStatus[];
  readonly sync: {
    readonly lastRunAt: string | null;
    readonly status: string | null;
    readonly since: string | null;
  };
  readonly warnings: readonly string[];
  readonly definitions: Readonly<Record<string, string>>;
}

const MAX_TABLE_ROWS = 25;

export function buildSummary(db: Db, window: MetricWindow, identity: Identity): ActivitySummary {
  const range = { fromMs: window.fromMs, toMs: window.toMs };
  const zone = window.timeZone;

  const authoredCommits = readCommitsAuthored(db, range, identity);
  const opened = readPullRequestsOpened(db, range, identity);
  const merged = readPullRequestsMerged(db, range, identity);
  const reviews = readReviewsGiven(db, range, identity);

  const mergeHours = merged.map((pr) => ((pr.merged_at_ms ?? 0) - pr.created_at_ms) / MS_PER_HOUR);

  const activeDays = new Set<string>();
  for (const commit of authoredCommits) activeDays.add(localDayKey(commit.authored_at_ms, zone));
  for (const pr of opened) activeDays.add(localDayKey(pr.created_at_ms, zone));
  for (const pr of merged) activeDays.add(localDayKey(pr.merged_at_ms ?? pr.created_at_ms, zone));
  for (const review of reviews) activeDays.add(localDayKey(review.submitted_at_ms, zone));

  const daily = buildDaily(window, authoredCommits, merged, reviews);
  const reviewTitles = readPullRequestTitles(db, reviews.map((r) => r.pull_request_source_id));
  const repositories = buildRepositoryStatus(db, range, identity, merged);

  return {
    generatedAt: new Date().toISOString(),
    window: {
      days: window.days,
      startDay: window.startDayKey,
      endDay: window.endDayKey,
      startIso: window.startIso,
      endIso: window.endIso,
      timeZone: zone,
    },
    identity: { githubLogin: identity.githubLogin, gitEmails: [...identity.gitEmails] },
    totals: {
      commitsAuthored: authoredCommits.length,
      pullRequestsOpened: opened.length,
      pullRequestsMerged: merged.length,
      reviewsGiven: reviews.length,
      pullRequestsReviewed: new Set(reviews.map((r) => r.pull_request_source_id)).size,
      activeDays: activeDays.size,
      additions: sum(authoredCommits.map((c) => c.additions)),
      deletions: sum(authoredCommits.map((c) => c.deletions)),
      filesChanged: sum(authoredCommits.map((c) => c.files_changed)),
      excludedAdditions: sum(authoredCommits.map((c) => c.excluded_additions)),
      excludedDeletions: sum(authoredCommits.map((c) => c.excluded_deletions)),
    },
    mergeTimeHours: {
      count: mergeHours.length,
      median: median(mergeHours),
      p75: percentile(mergeHours, 0.75),
      fastest: minOf(mergeHours),
      slowest: maxOf(mergeHours),
    },
    daily,
    landedPullRequests: merged.slice(0, MAX_TABLE_ROWS).map((pr) => ({
      repository: pr.repository_slug ?? pr.repository_key,
      number: pr.number,
      title: pr.title,
      mergedAt: pr.merged_at ?? "",
      mergeHours: ((pr.merged_at_ms ?? 0) - pr.created_at_ms) / MS_PER_HOUR,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      url: pr.source_url,
    })),
    recentCommits: authoredCommits.slice(0, MAX_TABLE_ROWS).map((commit) => ({
      repository: commit.repository_slug ?? commit.repository_key,
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 8),
      subject: commit.subject,
      committedAt: commit.committed_at,
      authoredAt: commit.authored_at,
      additions: commit.additions,
      deletions: commit.deletions,
      url: commit.source_url,
    })),
    recentReviews: reviews.slice(0, MAX_TABLE_ROWS).map((review) => ({
      repository: review.repository_slug ?? review.repository_key,
      pullRequestNumber: review.pull_request_number,
      title: reviewTitles.get(review.pull_request_source_id) ?? "",
      state: review.state,
      submittedAt: review.submitted_at,
      url: review.source_url,
    })),
    repositories,
    sync: buildSyncStatus(db),
    warnings: buildWarnings(
      identity,
      db,
      repositories,
      authoredCommits.length,
    ),
    definitions: DEFINITIONS,
  };
}

function buildDaily(
  window: MetricWindow,
  commits: readonly { authored_at_ms: number }[],
  merged: readonly { merged_at_ms: number | null; created_at_ms: number }[],
  reviews: readonly { submitted_at_ms: number }[],
): DailyBucket[] {
  const zone = window.timeZone;
  const buckets = new Map<string, { commits: number; merged: number; reviews: number }>();
  for (const day of window.dayKeys) buckets.set(day, { commits: 0, merged: 0, reviews: 0 });

  const bump = (day: string, field: "commits" | "merged" | "reviews"): void => {
    const bucket = buckets.get(day);
    if (bucket !== undefined) bucket[field] += 1;
  };

  for (const commit of commits) bump(localDayKey(commit.authored_at_ms, zone), "commits");
  for (const pr of merged) bump(localDayKey(pr.merged_at_ms ?? pr.created_at_ms, zone), "merged");
  for (const review of reviews) bump(localDayKey(review.submitted_at_ms, zone), "reviews");

  return window.dayKeys.map((date) => {
    const bucket = buckets.get(date) ?? { commits: 0, merged: 0, reviews: 0 };
    return {
      date,
      commitsAuthored: bucket.commits,
      pullRequestsMerged: bucket.merged,
      reviewsGiven: bucket.reviews,
    };
  });
}

function buildRepositoryStatus(
  db: Db,
  range: { readonly fromMs: number; readonly toMs: number },
  identity: Identity,
  merged: readonly { repository_key: string }[],
): RepositoryStatus[] {
  const mergedCounts = countBy(merged.map((pr) => pr.repository_key));
  const scope = new Map(
    readRepositoryCommitScope(db, range, identity).map((row) => [row.repository_key, row]),
  );

  return readRepositories(db).map((row) => {
    const observed = scope.get(row.key);
    return {
      key: row.key,
      slug: row.slug,
      localPath: row.local_path,
      defaultRef: row.default_ref,
      headSha: row.head_sha,
      headCommittedAt: row.head_committed_at,
      lastSyncedAt: row.last_synced_at,
      commitsAuthored: observed?.commits_matched ?? 0,
      commitsObserved: observed?.commits_observed ?? 0,
      authorEmails: (observed?.author_emails ?? "").split(",").filter(Boolean).sort(),
      pullRequestsMerged: mergedCounts.get(row.key) ?? 0,
    };
  });
}

function buildSyncStatus(db: Db): ActivitySummary["sync"] {
  const run = readLastSyncRun(db);
  if (run === null) return { lastRunAt: null, status: null, since: null };
  return { lastRunAt: run.finished_at ?? run.started_at, status: run.status, since: run.since };
}

function buildWarnings(
  identity: Identity,
  db: Db,
  repositories: readonly RepositoryStatus[],
  uniqueCommits: number,
): string[] {
  const warnings: string[] = [];
  if (identity.gitEmails.length === 0) {
    warnings.push(
      "No git emails configured, so no commits can be attributed to you. " +
        "Add them under identity.gitEmails.",
    );
  }
  if (identity.githubLogin === null) {
    warnings.push(
      "No GitHub login configured, so pull requests and reviews are not counted. " +
        "Set identity.githubLogin.",
    );
  }
  const matchedCopies = sum(repositories.map((repo) => repo.commitsAuthored));
  if (matchedCopies > uniqueCommits) {
    warnings.push(
      `${matchedCopies - uniqueCommits} duplicate commit ${matchedCopies - uniqueCommits === 1 ? "copy was" : "copies were"} ` +
        "found across configured repositories and counted once by SHA.",
    );
  }
  const run = readLastSyncRun(db);
  if (run === null) warnings.push("Nothing has been synced yet. Run `overview sync`.");
  else {
    if (run.status === "failed") warnings.push("The last sync reported errors; numbers may be incomplete.");
    warnings.push(...readSyncWarnings(run.notes));
  }
  return warnings;
}

function readSyncWarnings(notes: string | null): string[] {
  if (notes === null) return [];
  try {
    const parsed = JSON.parse(notes) as {
      warnings?: unknown;
      repositories?: { repositoryKey?: unknown; error?: unknown }[];
    };
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((value): value is string => typeof value === "string")
      : [];
    for (const repo of Array.isArray(parsed.repositories) ? parsed.repositories : []) {
      if (typeof repo.repositoryKey === "string" && typeof repo.error === "string") {
        warnings.push(`${repo.repositoryKey}: ${repo.error}`);
      }
    }
    return [...new Set(warnings)];
  } catch {
    return ["The last sync diagnostics could not be read; run `overview sync` again."];
  }
}

function countBy(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/** Stated in the payload so the dashboard can show exactly what it is counting. */
const DEFINITIONS: Readonly<Record<string, string>> = {
  commitsAuthored:
    "Non-merge commits authored by you that are reachable from each repository's default " +
    "branch, counted by author date. The original author and committer timestamps are both stored.",
  activeDays:
    "Local calendar days in the window with at least one commit you authored (by author " +
    "date), pull request you opened or landed, or review you submitted.",
  pullRequestsOpened: "Pull requests you opened, counted on their creation date.",
  pullRequestsMerged: "Pull requests you opened that were merged, counted on their merge date.",
  reviewsGiven:
    "Review submissions by you. Several submissions on one pull request count separately; " +
    "pullRequestsReviewed counts the distinct pull requests.",
  changeVolume:
    "Added and deleted lines over the counted commits, after removing paths matching " +
    "excludePaths. Removed lines are reported separately rather than discarded.",
  mergeTimeHours:
    "Hours from pull request creation to merge, for pull requests you opened that merged " +
    "in the window. Median and p75, never a mean: the distribution has a long tail.",
};
