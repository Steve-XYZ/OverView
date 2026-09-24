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
import { historyRange, monthlyWindows, type MetricWindow } from "./window.ts";

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

/** A landed pull request as evidence for a piece of work. `via` is empty when it names no issue. */
export interface ShippedPullRequest extends LandedPullRequest {
  readonly via: readonly PullRequestLinkEvidence[];
  /** Its recorded merge commit, when that commit was authored in the window. */
  readonly commits: readonly ShippedCommit[];
}

/** An authored commit as evidence for a piece of work. `via` is null when nothing links it. */
export interface ShippedCommit extends CommitEntry {
  readonly via: CommitLinkEvidence | null;
}

/**
 * A Linear issue the window's work names, or that was completed in the window.
 *
 * Only completed issues are published, so an issue still in progress arrives as an
 * identifier its links name and nothing more: `state` is null and `title` empty.
 */
export interface ShippedIssue {
  readonly identifier: string;
  readonly title: string;
  readonly url: string | null;
  readonly teamKey: string | null;
  readonly state: string | null;
  readonly completedAt: string;
  readonly completedInWindow: boolean;
  /** The latest of its evidence in the window and its completion in the window. */
  readonly shippedAt: string;
  readonly pullRequests: readonly ShippedPullRequest[];
  /** Commits naming the issue that are not the merge commit of one of `pullRequests`. */
  readonly commits: readonly ShippedCommit[];
}

export interface ShippedWork {
  readonly issues: readonly ShippedIssue[];
  readonly unlinkedPullRequests: readonly ShippedPullRequest[];
  readonly unlinkedCommits: readonly ShippedCommit[];
}

export interface MonthlyBucket {
  /** `YYYY-MM`. */
  readonly month: string;
  /** The month's first day, or where history starts when that is later. */
  readonly startDay: string;
  /** The month's last day, or the window's when the window ends inside it. */
  readonly endDay: string;
  readonly days: number;
  readonly commitsAuthored: number;
  readonly pullRequestsMerged: number;
  readonly reviewsGiven: number;
  readonly activeDays: number;
  readonly linearCompleted: number;
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
  /** Every piece of work in the window, uncapped. Absent from summaries stored before it existed. */
  readonly shipped?: ShippedWork;
  /** Only on a dashboard read, which loads the months before the window as well. */
  readonly trend?: readonly MonthlyBucket[];
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

/**
 * The loopback dashboard's read, which also needs the months before the window. The
 * trend starts where the last sync's window did: older rows may survive in the file,
 * but no sync has checked them since.
 */
export function buildDashboardSummary(
  db: Db,
  window: MetricWindow,
  identity: Identity,
  nowMs: number,
): ActivitySummary {
  const facts = collectFacts(db, historyRange(window, nowMs, null), identity, window.timeZone);
  const since = facts.collector.sync.since;
  return summarizeWithTrend(facts, window, since === null ? null : localDayKey(Date.parse(since), window.timeZone));
}

/**
 * `summarize`, plus the monthly trend. `facts` must reach back to
 * `historyRange(window, now, historyFromDay)`.
 */
export function summarizeWithTrend(
  facts: LedgerFacts,
  window: MetricWindow,
  historyFromDay: string | null,
): ActivitySummary {
  return { ...summarize(facts, window), trend: monthlyTrend(facts, window, historyFromDay) };
}

/**
 * The records each count is taken over. Every figure that counts commits, pull
 * requests or reviews starts here, whether for the window or for one month of the
 * trend, so the two cannot count differently.
 */
interface WindowActivity {
  readonly authoredCommits: readonly CommitFact[];
  readonly opened: readonly PullRequestFact[];
  readonly merged: readonly PullRequestFact[];
  readonly reviews: readonly ReviewFact[];
  readonly completedIssues: readonly LinearIssueFact[];
}

function selectActivity(facts: LedgerFacts, window: MetricWindow): WindowActivity {
  const inRange = (ms: number): boolean => ms >= window.fromMs && ms <= window.toMs;
  return {
    authoredCommits: facts.commits
      .filter((commit) => inRange(commit.authoredAtMs))
      .sort((left, right) => right.authoredAtMs - left.authoredAtMs || left.sha.localeCompare(right.sha)),
    opened: facts.pullRequests
      .filter((pr) => pr.authoredByViewer && inRange(pr.createdAtMs))
      .sort((left, right) => right.createdAtMs - left.createdAtMs || comparePullRequests(left, right)),
    merged: facts.pullRequests
      .filter((pr) => pr.authoredByViewer && pr.mergedAtMs !== null && inRange(pr.mergedAtMs))
      .sort(
        (left, right) =>
          (right.mergedAtMs ?? 0) - (left.mergedAtMs ?? 0) || comparePullRequests(left, right),
      ),
    reviews: facts.reviews
      .filter((review) => inRange(review.submittedAtMs))
      .sort(
        (left, right) =>
          right.submittedAtMs - left.submittedAtMs || left.sourceId.localeCompare(right.sourceId),
      ),
    completedIssues: facts.linearIssues
      .filter((issue) => issue.completedAtMs !== null && inRange(issue.completedAtMs))
      .sort(
        (left, right) =>
          (right.completedAtMs ?? 0) - (left.completedAtMs ?? 0) ||
          left.identifier.localeCompare(right.identifier),
      ),
  };
}

function countActiveDays(activity: WindowActivity, zone: string): number {
  const activeDays = new Set<string>();
  for (const commit of activity.authoredCommits) activeDays.add(localDayKey(commit.authoredAtMs, zone));
  for (const pr of activity.opened) activeDays.add(localDayKey(pr.createdAtMs, zone));
  for (const pr of activity.merged) activeDays.add(localDayKey(pr.mergedAtMs ?? pr.createdAtMs, zone));
  for (const review of activity.reviews) activeDays.add(localDayKey(review.submittedAtMs, zone));
  return activeDays.size;
}

/**
 * One bucket per calendar month of `monthlyWindows`, each counted by the same
 * selection as the window's own totals. Without a known start of history, months
 * before the first one with any activity are dropped unless they overlap the
 * window, because a run of zeros there would read as time off.
 */
function monthlyTrend(facts: LedgerFacts, window: MetricWindow, historyFromDay: string | null): MonthlyBucket[] {
  const buckets = monthlyWindows(window, historyFromDay).map((month): MonthlyBucket => {
    const activity = selectActivity(facts, month);
    return {
      month: month.startDayKey.slice(0, 7),
      startDay: month.startDayKey,
      endDay: month.endDayKey,
      days: month.days,
      commitsAuthored: activity.authoredCommits.length,
      pullRequestsMerged: activity.merged.length,
      reviewsGiven: activity.reviews.length,
      activeDays: countActiveDays(activity, month.timeZone),
      linearCompleted: activity.completedIssues.length,
    };
  });
  if (historyFromDay !== null) return buckets;
  const first = buckets.findIndex(
    (bucket) => bucket.activeDays > 0 || bucket.linearCompleted > 0 || bucket.endDay >= window.startDayKey,
  );
  return buckets.slice(first);
}

export function summarize(facts: LedgerFacts, window: MetricWindow): ActivitySummary {
  const zone = window.timeZone;
  const activity = selectActivity(facts, window);
  const { authoredCommits, merged, reviews } = activity;

  const mergeHours = merged.map((pr) => ((pr.mergedAtMs ?? 0) - pr.createdAtMs) / MS_PER_HOUR);

  const name = repositoryNames(facts.repositories);
  const titles = pullRequestTitles(facts.pullRequests);
  const repositories = buildRepositoryStatus(facts, window, merged);
  const links = linkEvidence(facts, activity, name, titles);

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
      pullRequestsOpened: activity.opened.length,
      pullRequestsMerged: merged.length,
      reviewsGiven: reviews.length,
      pullRequestsReviewed: new Set(
        reviews.map((review) => pullRequestFactKey(review.repositoryKey, review.pullRequestNumber)),
      ).size,
      activeDays: countActiveDays(activity, zone),
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
    landedPullRequests: merged.slice(0, MAX_TABLE_ROWS).map(links.landed),
    recentCommits: authoredCommits.slice(0, MAX_TABLE_ROWS).map(links.commit),
    recentReviews: reviews.slice(0, MAX_TABLE_ROWS).map((review) => ({
      repository: name(review.repositoryKey),
      pullRequestNumber: review.pullRequestNumber,
      title: titles.get(pullRequestFactKey(review.repositoryKey, review.pullRequestNumber)) ?? "",
      state: review.state,
      submittedAt: factIso(review.submittedAtMs),
      url: review.sourceUrl,
    })),
    repositories,
    linear: buildLinearSection(facts, activity, links),
    shipped: buildShipped(facts, activity, links),
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

interface IssueLink<Via> {
  readonly identifier: string;
  readonly via: Via;
}

/**
 * Which issues the window's pull requests and commits name, and the display rows
 * both the Linear section and the shipped-work timeline build from them.
 *
 * Links arrive as facts because they were read from a title, a branch name or a
 * commit subject — the strings publishing removes. One kind is still derived here:
 * a squash commit that is the recorded merge commit of a linked pull request
 * belongs to that pull request's issues, and whether the pull request landed in
 * *this* window is what decides it, so it cannot be settled at publication time.
 */
interface LinkEvidence {
  readonly landed: (pr: PullRequestFact) => LandedPullRequest;
  readonly commit: (commit: CommitFact) => CommitEntry;
  readonly pullRequestLinks: (pr: PullRequestFact) => readonly IssueLink<readonly PullRequestLinkEvidence[]>[];
  readonly commitLinks: (commit: CommitFact) => readonly IssueLink<CommitLinkEvidence>[];
  readonly name: (repositoryKey: string) => string;
  readonly titles: ReadonlyMap<string, string>;
}

function linkEvidence(
  facts: LedgerFacts,
  activity: WindowActivity,
  name: (repositoryKey: string) => string,
  titles: ReadonlyMap<string, string>,
): LinkEvidence {
  const linksByPullRequest = new Map<string, IssueLink<readonly PullRequestLinkEvidence[]>[]>();
  for (const link of facts.pullRequestLinks) {
    const key = pullRequestFactKey(link.repositoryKey, link.pullRequestNumber);
    const list = linksByPullRequest.get(key) ?? [];
    list.push({ identifier: link.issueIdentifier, via: link.via });
    linksByPullRequest.set(key, list);
  }
  const pullRequestLinks = (pr: PullRequestFact): readonly IssueLink<readonly PullRequestLinkEvidence[]>[] =>
    linksByPullRequest.get(pullRequestFactKey(pr.repositoryKey, pr.number)) ?? [];

  // Squash commits often drop the issue key from their subject. When a commit is
  // the recorded merge commit of a linked PR, it belongs to the same issues.
  const mergeShaToIdentifiers = new Map<string, string[]>();
  for (const pr of activity.merged) {
    const sha = pr.mergeCommitSha;
    const links = pullRequestLinks(pr);
    if (sha === null || links.length === 0) continue;
    const existing = mergeShaToIdentifiers.get(sha.toLowerCase());
    const identifiers = links.map((link) => link.identifier);
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
  const commitLinks = (commit: CommitFact): readonly IssueLink<CommitLinkEvidence>[] => {
    const direct = (subjectLinks.get(commit.sha.toLowerCase()) ?? []).filter(
      (link) => link.repositoryKey === commit.repositoryKey,
    );
    const directIds = new Set(direct.map((link) => link.issueIdentifier));
    const links: IssueLink<CommitLinkEvidence>[] = direct.map((link) => ({
      identifier: link.issueIdentifier,
      via: link.via,
    }));
    for (const identifier of mergeShaToIdentifiers.get(commit.sha.toLowerCase()) ?? []) {
      if (!directIds.has(identifier)) links.push({ identifier, via: "pr_merge_commit" });
    }
    return links;
  };

  return {
    landed: (pr) => ({
      repository: name(pr.repositoryKey),
      number: pr.number,
      title: pr.title,
      mergedAt: factIso(pr.mergedAtMs),
      mergeHours: ((pr.mergedAtMs ?? 0) - pr.createdAtMs) / MS_PER_HOUR,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      url: pr.sourceUrl,
    }),
    commit: (commit) => ({
      repository: name(commit.repositoryKey),
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 8),
      subject: commit.subject,
      committedAt: factIso(commit.committedAtMs),
      authoredAt: factIso(commit.authoredAtMs),
      additions: commit.additions,
      deletions: commit.deletions,
      url: commit.sourceUrl,
    }),
    pullRequestLinks,
    commitLinks,
    name,
    titles,
  };
}

/** Completed Linear issues in the window, each with the window's PRs and commits that named it. */
function buildLinearSection(
  facts: LedgerFacts,
  activity: WindowActivity,
  links: LinkEvidence,
): ActivitySummary["linear"] {
  const { merged, authoredCommits, completedIssues: completed } = activity;
  const linkedPullRequests = merged.filter((pr) => links.pullRequestLinks(pr).length > 0).length;

  const prsByIssue = new Map<string, LinearLinkedPullRequest[]>();
  for (const pr of merged) {
    for (const link of links.pullRequestLinks(pr)) {
      const list = prsByIssue.get(link.identifier) ?? [];
      list.push({
        repository: links.name(pr.repositoryKey),
        number: pr.number,
        title: links.titles.get(pullRequestFactKey(pr.repositoryKey, pr.number)) ?? "",
        mergedAt: factIso(pr.mergedAtMs),
        url: pr.sourceUrl,
        via: link.via,
      });
      prsByIssue.set(link.identifier, list);
    }
  }

  const commitsByIssue = new Map<string, LinearLinkedCommit[]>();
  for (const commit of authoredCommits) {
    for (const link of links.commitLinks(commit)) {
      const list = commitsByIssue.get(link.identifier) ?? [];
      list.push({
        repository: links.name(commit.repositoryKey),
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

/**
 * Every landed pull request and authored commit in the window, grouped under the
 * issues they name, plus the issues completed in the window. What names no issue
 * stays visible on its own: a pull request with its squash commit, and the commits
 * left over. A pull request naming two issues is evidence for both.
 */
function buildShipped(facts: LedgerFacts, activity: WindowActivity, links: LinkEvidence): ShippedWork {
  interface IssueWork {
    readonly prs: ShippedPullRequest[];
    readonly commits: ShippedCommit[];
    /** Merge commit SHA to the commit list of the issue's pull request it merged. */
    readonly bySquash: Map<string, ShippedCommit[]>;
    latestMs: number;
  }
  const issues = new Map<string, IssueWork>();
  const issueWork = (identifier: string): IssueWork => {
    let work = issues.get(identifier);
    if (work === undefined) {
      work = { prs: [], commits: [], bySquash: new Map(), latestMs: 0 };
      issues.set(identifier, work);
    }
    return work;
  };
  const shippedPullRequest = (
    pr: PullRequestFact,
    via: readonly PullRequestLinkEvidence[],
    bySquash: Map<string, ShippedCommit[]>,
  ): ShippedPullRequest => {
    const commits: ShippedCommit[] = [];
    if (pr.mergeCommitSha !== null) bySquash.set(pr.mergeCommitSha.toLowerCase(), commits);
    return { ...links.landed(pr), via, commits };
  };

  const unlinkedPullRequests: ShippedPullRequest[] = [];
  const unlinkedBySquash = new Map<string, ShippedCommit[]>();
  for (const pr of activity.merged) {
    const prLinks = links.pullRequestLinks(pr);
    if (prLinks.length === 0) unlinkedPullRequests.push(shippedPullRequest(pr, [], unlinkedBySquash));
    for (const link of prLinks) {
      const work = issueWork(link.identifier);
      work.prs.push(shippedPullRequest(pr, link.via, work.bySquash));
      work.latestMs = Math.max(work.latestMs, pr.mergedAtMs ?? 0);
    }
  }

  // A commit sits under the pull request it is the merge commit of, wherever that
  // pull request is listed, so each piece of work is one entry with its evidence.
  const unlinkedCommits: ShippedCommit[] = [];
  for (const commit of activity.authoredCommits) {
    const sha = commit.sha.toLowerCase();
    const commitLinks = links.commitLinks(commit);
    for (const link of commitLinks) {
      const work = issueWork(link.identifier);
      (work.bySquash.get(sha) ?? work.commits).push({ ...links.commit(commit), via: link.via });
      work.latestMs = Math.max(work.latestMs, commit.authoredAtMs);
    }
    if (commitLinks.length > 0) continue;
    const squashOf = unlinkedBySquash.get(sha);
    if (squashOf !== undefined) squashOf.push({ ...links.commit(commit), via: "pr_merge_commit" });
    else unlinkedCommits.push({ ...links.commit(commit), via: null });
  }

  const completedInWindow = new Set(activity.completedIssues.map((issue) => issue.identifier));
  for (const issue of activity.completedIssues) {
    const work = issueWork(issue.identifier);
    work.latestMs = Math.max(work.latestMs, issue.completedAtMs ?? 0);
  }
  const records = new Map(facts.linearIssues.map((issue) => [issue.identifier, issue]));

  return {
    issues: [...issues.entries()]
      .map(([identifier, work]): ShippedIssue => {
        const record = records.get(identifier);
        return {
          identifier,
          title: record?.title ?? "",
          url: record?.sourceUrl ?? null,
          teamKey: record?.teamKey ?? null,
          state: record?.stateName ?? null,
          completedAt: factIso(record?.completedAtMs ?? null),
          completedInWindow: completedInWindow.has(identifier),
          shippedAt: factIso(work.latestMs),
          pullRequests: work.prs,
          commits: work.commits,
        };
      })
      .sort(
        (left, right) =>
          right.shippedAt.localeCompare(left.shippedAt) || left.identifier.localeCompare(right.identifier),
      ),
    unlinkedPullRequests,
    unlinkedCommits,
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
  shippedWork:
    "Every pull request you landed and every commit you authored in the range, grouped under " +
    "the Linear issue its title, branch or subject names, plus the issues completed in the " +
    "range. A pull request naming two issues is listed under both. Work that names no issue " +
    "is listed separately: each landed pull request with its squash commit, then the other commits.",
  monthlyTrend:
    "Calendar months up to the end of the range, up to twelve or the range's length, counted " +
    "with the same rules as the totals. Nothing before the start of synced or published " +
    "history is counted, so the first month may be partial.",
};
