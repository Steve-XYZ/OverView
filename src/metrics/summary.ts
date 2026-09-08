/**
 * The metric queries.
 *
 * This module owns every definition the dashboard shows. Each number is derived from
 * the normalized facts in `domain/facts.ts`, and each row carries the identifier and
 * URL it came from, so `definitions` below plus the tables underneath the chart are
 * enough to check any figure by hand.
 *
 * `summarize` is pure and takes facts rather than a database, because there are two
 * stores now: the local SQLite file and the per-user ledger in Neon. Running one
 * implementation over both is what makes the hosted dashboard reproduce the local
 * report rather than approximate it.
 *
 * The facts handed in may cover more than the window — the publisher collects once
 * and answers 7, 30 and 90 days from that — so every query filters by timestamp
 * here rather than trusting its input to be pre-cut.
 */

import type {
  CommitFact,
  CommitIssueLinkFact,
  LedgerFacts,
  LinearDataStatus,
  LinearIssueFact,
  PullRequestFact,
  RepositoryFact,
  ReviewFact,
} from "../domain/facts.ts";
import { factIso, pullRequestFactKey } from "../domain/facts.ts";
import type { CommitLinkEvidence, PullRequestLinkEvidence } from "../domain/linear.ts";
import type { Identity } from "../domain/types.ts";
import { MS_PER_HOUR, localDayKey } from "../domain/time.ts";
import type { Db } from "../store/db.ts";
import { collectFacts } from "../store/facts.ts";
import { maxOf, median, minOf, percentile, sum } from "./stats.ts";
import type { MetricWindow } from "./window.ts";

export type { LinearDataStatus } from "../domain/facts.ts";

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

export interface LinearLinkedPullRequest {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly mergedAt: string;
  readonly url: string | null;
  /** Which PR field named the issue. Retained so a link can be checked by hand. */
  readonly via: readonly PullRequestLinkEvidence[];
}

export interface LinearLinkedCommit {
  readonly repository: string;
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly authoredAt: string;
  readonly url: string | null;
  /** `commit_subject` when the subject names the issue, `pr_merge_commit` when the
   * commit is the squash commit of a linked PR whose subject does not. */
  readonly via: CommitLinkEvidence;
}

export interface LinearCompletedIssue {
  readonly identifier: string;
  readonly title: string;
  readonly state: string;
  readonly completedAt: string;
  readonly url: string | null;
  readonly teamKey: string | null;
  readonly pullRequests: readonly LinearLinkedPullRequest[];
  readonly commits: readonly LinearLinkedCommit[];
}

export interface ActivitySummary {
  readonly generatedAt: string;
  /** Set by the hosted read API. Local summaries intentionally omit it. */
  readonly publishedAt?: string;
  /** Set by the hosted read API to name the signed-in account. Local reads omit it. */
  readonly account?: { readonly githubLogin: string };
  /** Set by the hosted read API to name the store the numbers came from. */
  readonly source?: "ledger" | "snapshot";
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
  readonly linear: {
    readonly syncStatus: LinearDataStatus;
    readonly completedIssuesTotal: number;
    readonly completedIssues: readonly LinearCompletedIssue[];
    readonly coverage: {
      readonly landedPullRequests: number;
      readonly linkedPullRequests: number;
      readonly unlinkedPullRequests: number;
      readonly linkedShare: number | null;
    };
  };
  readonly sync: {
    readonly lastRunAt: string | null;
    readonly status: string | null;
    readonly since: string | null;
  };
  readonly warnings: readonly string[];
  readonly definitions: Readonly<Record<string, string>>;
}

const MAX_TABLE_ROWS = 25;

/** The local report and loopback dashboard: read the SQLite file, then summarise it. */
export function buildSummary(db: Db, window: MetricWindow, identity: Identity): ActivitySummary {
  return summarize(
    collectFacts(db, { fromMs: window.fromMs, toMs: window.toMs }, identity, window.timeZone),
    window,
  );
}

export function summarize(facts: LedgerFacts, window: MetricWindow): ActivitySummary {
  const zone = window.timeZone;
  const inRange = (ms: number): boolean => ms >= window.fromMs && ms <= window.toMs;

  const authoredCommits = facts.commits
    .filter((commit) => inRange(commit.authoredAtMs))
    .sort((left, right) => right.authoredAtMs - left.authoredAtMs || left.sha.localeCompare(right.sha));
  const opened = facts.pullRequests
    .filter((pr) => pr.authoredByViewer && inRange(pr.createdAtMs))
    .sort((left, right) => right.createdAtMs - left.createdAtMs || comparePullRequests(left, right));
  const merged = facts.pullRequests
    .filter((pr) => pr.authoredByViewer && pr.mergedAtMs !== null && inRange(pr.mergedAtMs))
    .sort(
      (left, right) =>
        (right.mergedAtMs ?? 0) - (left.mergedAtMs ?? 0) || comparePullRequests(left, right),
    );
  const reviews = facts.reviews
    .filter((review) => inRange(review.submittedAtMs))
    .sort(
      (left, right) =>
        right.submittedAtMs - left.submittedAtMs || left.sourceId.localeCompare(right.sourceId),
    );

  const mergeHours = merged.map((pr) => ((pr.mergedAtMs ?? 0) - pr.createdAtMs) / MS_PER_HOUR);

  const activeDays = new Set<string>();
  for (const commit of authoredCommits) activeDays.add(localDayKey(commit.authoredAtMs, zone));
  for (const pr of opened) activeDays.add(localDayKey(pr.createdAtMs, zone));
  for (const pr of merged) activeDays.add(localDayKey(pr.mergedAtMs ?? pr.createdAtMs, zone));
  for (const review of reviews) activeDays.add(localDayKey(review.submittedAtMs, zone));

  const name = repositoryNames(facts.repositories);
  const titles = pullRequestTitles(facts.pullRequests);
  const repositories = buildRepositoryStatus(facts, window, merged);
  const linear = buildLinearSection(facts, window, merged, authoredCommits, name, titles);

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
    identity: {
      githubLogin: facts.collector.identity.githubLogin,
      gitEmails: [...facts.collector.identity.gitEmails],
    },
    totals: {
      commitsAuthored: authoredCommits.length,
      pullRequestsOpened: opened.length,
      pullRequestsMerged: merged.length,
      reviewsGiven: reviews.length,
      pullRequestsReviewed: new Set(
        reviews.map((review) => pullRequestFactKey(review.repositoryKey, review.pullRequestNumber)),
      ).size,
      activeDays: activeDays.size,
      additions: sum(authoredCommits.map((c) => c.additions)),
      deletions: sum(authoredCommits.map((c) => c.deletions)),
      filesChanged: sum(authoredCommits.map((c) => c.filesChanged)),
      excludedAdditions: sum(authoredCommits.map((c) => c.excludedAdditions)),
      excludedDeletions: sum(authoredCommits.map((c) => c.excludedDeletions)),
    },
    mergeTimeHours: {
      count: mergeHours.length,
      median: median(mergeHours),
      p75: percentile(mergeHours, 0.75),
      fastest: minOf(mergeHours),
      slowest: maxOf(mergeHours),
    },
    daily: buildDaily(window, authoredCommits, merged, reviews),
    landedPullRequests: merged.slice(0, MAX_TABLE_ROWS).map((pr) => ({
      repository: name(pr.repositoryKey),
      number: pr.number,
      title: pr.title,
      mergedAt: factIso(pr.mergedAtMs),
      mergeHours: ((pr.mergedAtMs ?? 0) - pr.createdAtMs) / MS_PER_HOUR,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      url: pr.sourceUrl,
    })),
    recentCommits: authoredCommits.slice(0, MAX_TABLE_ROWS).map((commit) => ({
      repository: name(commit.repositoryKey),
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 8),
      subject: commit.subject,
      committedAt: factIso(commit.committedAtMs),
      authoredAt: factIso(commit.authoredAtMs),
      additions: commit.additions,
      deletions: commit.deletions,
      url: commit.sourceUrl,
    })),
    recentReviews: reviews.slice(0, MAX_TABLE_ROWS).map((review) => ({
      repository: name(review.repositoryKey),
      pullRequestNumber: review.pullRequestNumber,
      title: titles.get(pullRequestFactKey(review.repositoryKey, review.pullRequestNumber)) ?? "",
      state: review.state,
      submittedAt: factIso(review.submittedAtMs),
      url: review.sourceUrl,
    })),
    repositories,
    linear,
    sync: {
      lastRunAt: facts.collector.sync.lastRunAt,
      status: facts.collector.sync.status,
      since: facts.collector.sync.since,
    },
    warnings: buildWarnings(facts, repositories, authoredCommits.length),
    definitions: DEFINITIONS,
  };
}

/**
 * Display name for a repository key: its slug when it has one, the key otherwise.
 * Publishing rewrites both, so a redacted checkout shows its published alias here
 * without this function knowing anything about redaction.
 */
function repositoryNames(
  repositories: readonly RepositoryFact[],
): (repositoryKey: string) => string {
  const names = new Map(repositories.map((repo) => [repo.key, repo.slug ?? repo.key]));
  return (repositoryKey: string): string => names.get(repositoryKey) ?? repositoryKey;
}

function pullRequestTitles(pullRequests: readonly PullRequestFact[]): ReadonlyMap<string, string> {
  return new Map(
    pullRequests.map((pr) => [pullRequestFactKey(pr.repositoryKey, pr.number), pr.title]),
  );
}

function comparePullRequests(left: PullRequestFact, right: PullRequestFact): number {
  return left.repositoryKey.localeCompare(right.repositoryKey) || left.number - right.number;
}

function buildDaily(
  window: MetricWindow,
  commits: readonly CommitFact[],
  merged: readonly PullRequestFact[],
  reviews: readonly ReviewFact[],
): DailyBucket[] {
  const zone = window.timeZone;
  const buckets = new Map<string, { commits: number; merged: number; reviews: number }>();
  for (const day of window.dayKeys) buckets.set(day, { commits: 0, merged: 0, reviews: 0 });

  const bump = (day: string, field: "commits" | "merged" | "reviews"): void => {
    const bucket = buckets.get(day);
    if (bucket !== undefined) bucket[field] += 1;
  };

  for (const commit of commits) bump(localDayKey(commit.authoredAtMs, zone), "commits");
  for (const pr of merged) bump(localDayKey(pr.mergedAtMs ?? pr.createdAtMs, zone), "merged");
  for (const review of reviews) bump(localDayKey(review.submittedAtMs, zone), "reviews");

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

/**
 * Per-repository status, including the volume other people committed.
 *
 * The observed columns are summed from the per-day records rather than counted from
 * commit records, because commit records only ever cover the user's own work. Days
 * with no activity have no record and contribute nothing.
 */
function buildRepositoryStatus(
  facts: LedgerFacts,
  window: MetricWindow,
  merged: readonly PullRequestFact[],
): RepositoryStatus[] {
  const inWindow = new Set(window.dayKeys);
  const mergedCounts = countBy(merged.map((pr) => pr.repositoryKey));
  const observed = new Map<string, { observed: number; matched: number; emails: Set<string> }>();

  for (const day of facts.repositoryDays) {
    if (!inWindow.has(day.day)) continue;
    let bucket = observed.get(day.repositoryKey);
    if (bucket === undefined) {
      bucket = { observed: 0, matched: 0, emails: new Set() };
      observed.set(day.repositoryKey, bucket);
    }
    bucket.observed += day.commitsObserved;
    bucket.matched += day.commitsMatched;
    for (const email of day.authorEmails) bucket.emails.add(email);
  }

  return [...facts.repositories]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((repo) => {
      const scope = observed.get(repo.key);
      return {
        key: repo.key,
        slug: repo.slug,
        localPath: repo.localPath,
        defaultRef: repo.defaultRef,
        headSha: repo.headSha,
        headCommittedAt: repo.headCommittedAt,
        lastSyncedAt: repo.lastSyncedAt,
        commitsAuthored: scope?.matched ?? 0,
        commitsObserved: scope?.observed ?? 0,
        authorEmails: [...(scope?.emails ?? [])].sort(),
        pullRequestsMerged: mergedCounts.get(repo.key) ?? 0,
      };
    });
}

/**
 * Completed Linear issues in the window, each with the window's PRs and commits
 * that named it.
 *
 * Links arrive as facts because they were read from a title, a branch name or a
 * commit subject — the strings publishing removes. One kind is still derived here:
 * a squash commit that is the recorded merge commit of a linked pull request
 * belongs to that pull request's issues, and whether the pull request landed in
 * *this* window is what decides it, so it cannot be settled at publication time.
 */
function buildLinearSection(
  facts: LedgerFacts,
  window: MetricWindow,
  merged: readonly PullRequestFact[],
  authoredCommits: readonly CommitFact[],
  name: (repositoryKey: string) => string,
  titles: ReadonlyMap<string, string>,
): ActivitySummary["linear"] {
  const linksByPullRequest = new Map<string, { identifier: string; via: readonly PullRequestLinkEvidence[] }[]>();
  for (const link of facts.pullRequestLinks) {
    const key = pullRequestFactKey(link.repositoryKey, link.pullRequestNumber);
    const list = linksByPullRequest.get(key) ?? [];
    list.push({ identifier: link.issueIdentifier, via: link.via });
    linksByPullRequest.set(key, list);
  }

  const prLinks = merged.map((pr) => ({
    pr,
    links: linksByPullRequest.get(pullRequestFactKey(pr.repositoryKey, pr.number)) ?? [],
  }));
  const linkedPullRequests = prLinks.filter((entry) => entry.links.length > 0).length;

  // Squash commits often drop the issue key from their subject. When a commit is
  // the recorded merge commit of a linked PR, it belongs to the same issues.
  const mergeShaToIdentifiers = new Map<string, string[]>();
  for (const entry of prLinks) {
    const sha = entry.pr.mergeCommitSha;
    if (sha === null || entry.links.length === 0) continue;
    const existing = mergeShaToIdentifiers.get(sha.toLowerCase());
    const identifiers = entry.links.map((link) => link.identifier);
    if (existing === undefined) mergeShaToIdentifiers.set(sha.toLowerCase(), [...identifiers]);
    else for (const identifier of identifiers) {
      if (!existing.includes(identifier)) existing.push(identifier);
    }
  }

  const subjectLinks = new Map<string, CommitIssueLinkFact[]>();
  for (const link of facts.commitLinks) {
    const list = subjectLinks.get(link.sha.toLowerCase()) ?? [];
    list.push(link);
    subjectLinks.set(link.sha.toLowerCase(), list);
  }

  const prsByIssue = new Map<string, LinearLinkedPullRequest[]>();
  for (const entry of prLinks) {
    for (const link of entry.links) {
      const list = prsByIssue.get(link.identifier) ?? [];
      list.push({
        repository: name(entry.pr.repositoryKey),
        number: entry.pr.number,
        title: titles.get(pullRequestFactKey(entry.pr.repositoryKey, entry.pr.number)) ?? "",
        mergedAt: factIso(entry.pr.mergedAtMs),
        url: entry.pr.sourceUrl,
        via: link.via,
      });
      prsByIssue.set(link.identifier, list);
    }
  }

  const commitsByIssue = new Map<string, LinearLinkedCommit[]>();
  for (const commit of authoredCommits) {
    const direct = (subjectLinks.get(commit.sha.toLowerCase()) ?? []).filter(
      (link) => link.repositoryKey === commit.repositoryKey,
    );
    const directIds = new Set(direct.map((link) => link.issueIdentifier));
    const links: { identifier: string; via: CommitLinkEvidence }[] = direct.map((link) => ({
      identifier: link.issueIdentifier,
      via: link.via,
    }));
    for (const identifier of mergeShaToIdentifiers.get(commit.sha.toLowerCase()) ?? []) {
      if (!directIds.has(identifier)) links.push({ identifier, via: "pr_merge_commit" });
    }
    for (const link of links) {
      const list = commitsByIssue.get(link.identifier) ?? [];
      list.push({
        repository: name(commit.repositoryKey),
        sha: commit.sha,
        shortSha: commit.sha.slice(0, 8),
        subject: commit.subject,
        authoredAt: factIso(commit.authoredAtMs),
        url: commit.sourceUrl,
        via: link.via,
      });
      commitsByIssue.set(link.identifier, list);
    }
  }

  const completed = facts.linearIssues
    .filter(
      (issue) =>
        issue.completedAtMs !== null &&
        issue.completedAtMs >= window.fromMs &&
        issue.completedAtMs <= window.toMs,
    )
    .sort(
      (left, right) =>
        (right.completedAtMs ?? 0) - (left.completedAtMs ?? 0) ||
        left.identifier.localeCompare(right.identifier),
    );

  return {
    syncStatus: facts.collector.linearSyncStatus,
    completedIssuesTotal: completed.length,
    completedIssues: completed.slice(0, MAX_TABLE_ROWS).map((issue: LinearIssueFact) => ({
      identifier: issue.identifier,
      title: issue.title,
      state: issue.stateName,
      completedAt: factIso(issue.completedAtMs),
      url: issue.sourceUrl,
      teamKey: issue.teamKey,
      pullRequests: prsByIssue.get(issue.identifier) ?? [],
      commits: commitsByIssue.get(issue.identifier) ?? [],
    })),
    coverage: {
      landedPullRequests: merged.length,
      linkedPullRequests,
      unlinkedPullRequests: merged.length - linkedPullRequests,
      linkedShare: merged.length === 0 ? null : linkedPullRequests / merged.length,
    },
  };
}

function buildWarnings(
  facts: LedgerFacts,
  repositories: readonly RepositoryStatus[],
  uniqueCommits: number,
): string[] {
  const warnings: string[] = [];
  if (!facts.collector.identity.gitEmailsConfigured) {
    warnings.push(
      "No git emails configured, so no commits can be attributed to you. " +
        "Add them under identity.gitEmails.",
    );
  }
  if (facts.collector.identity.githubLogin === null) {
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
  if (facts.collector.sync.lastRunAt === null) {
    warnings.push("Nothing has been synced yet. Run `overview sync`.");
  } else {
    if (facts.collector.sync.status === "failed") {
      warnings.push("The last sync reported errors; numbers may be incomplete.");
    }
    warnings.push(...facts.collector.sync.warnings);
  }
  return warnings;
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
  linearCompleted:
    "Linear issues assigned to you, counted on the day they entered a completed state. " +
    "Only issues synced via LINEAR_API_KEY appear; open or canceled issues do not.",
  linearCoverage:
    "Share of your landed pull requests in the window whose title or source branch names " +
    "a synced Linear issue (for example BOS-2422). A pull request only counts as linked " +
    "when the identifier matches an issue already in the database; each link keeps whether " +
    "it came from the title or the branch. Commits link the same way through their subject, " +
    "or as the squash commit of a linked pull request.",
};
