/**
 * The normalized fact records the dashboard is computed from.
 *
 * `domain/types.ts` describes what a collector *produces*; this file describes what
 * a metric query *consumes*. The distinction matters because there are now two
 * stores behind the same metrics: the local SQLite file, and the per-user ledger in
 * Neon. Both are read into the shapes below, and `metrics/summary.ts` derives every
 * number from them, so the hosted dashboard cannot drift away from the local report
 * by reimplementing a definition.
 *
 * These shapes are therefore also the cloud publication contract. Two rules follow:
 *
 *  - Every field must be safe to store in Neon *after* redaction. There is no field
 *    here that redaction cannot empty or null, and no field carries a local path, a
 *    commit email, or a credential.
 *  - Timestamps are epoch milliseconds only. The local store keeps both an ISO
 *    string and a millisecond copy; carrying one of them and deriving the other
 *    (`new Date(ms).toISOString()`, which is exactly what `toIsoUtc` wrote) removes
 *    the chance of the two disagreeing across a network boundary.
 */

import type { CommitLinkEvidence, PullRequestLinkEvidence } from "./linear.ts";
import type { PullRequestState } from "./types.ts";

/** How the last sync left the Linear slice. `unknown` covers pre-Linear runs. */
export type LinearDataStatus = "synced" | "missing_key" | "skipped" | "failed" | "unknown";

/** A repository the collector is configured to watch. */
export interface RepositoryFact {
  /** `github:owner/name`, or the published alias of a path-backed checkout. */
  readonly key: string;
  readonly slug: string | null;
  /** Always null once redacted; retained locally for the loopback dashboard. */
  readonly localPath: string | null;
  readonly defaultRef: string | null;
  readonly headSha: string | null;
  readonly headCommittedAt: string | null;
  readonly lastSyncedAt: string | null;
}

/**
 * One repository's observed commit volume for one local calendar day.
 *
 * The dashboard shows "your commits / all commits" and the addresses seen in each
 * repository, which are aggregates over everybody's commits — not facts about the
 * user. Publishing them per day rather than per window is what lets the hosted side
 * answer a range it was never told about at publication time, by summing the days
 * it holds. Per-commit records for other people are deliberately never published.
 */
export interface RepositoryDayFact {
  readonly repositoryKey: string;
  /** `YYYY-MM-DD` in the collector's zone, which the publication states. */
  readonly day: string;
  /** Non-merge commits by anyone, reachable from the default branch. */
  readonly commitsObserved: number;
  /** Of those, the ones matching the configured identity. Counted per repository,
   * so a commit present in a fork and its upstream counts in both. */
  readonly commitsMatched: number;
  /** Distinct author addresses seen. Emptied by redaction. */
  readonly authorEmails: readonly string[];
}

/**
 * A non-merge commit authored by the user.
 *
 * Identified by SHA alone: the same commit reachable from a fork and its upstream is
 * one fact, and the `repositoryKey` records the copy the collector counted, matching
 * the local rule that a duplicate SHA counts once.
 */
export interface CommitFact {
  readonly repositoryKey: string;
  readonly sha: string;
  readonly authoredAtMs: number;
  readonly committedAtMs: number;
  /** Emptied by redaction. */
  readonly subject: string;
  readonly additions: number;
  readonly deletions: number;
  readonly filesChanged: number;
  readonly excludedAdditions: number;
  readonly excludedDeletions: number;
  /** Nulled by redaction. */
  readonly sourceUrl: string | null;
  readonly recordedAt: string;
}

/**
 * A pull request the user opened or reviewed. Identified by repository and number,
 * which is the identity GitHub itself guarantees unique and which the dashboard
 * already displays; the GraphQL node id is not published.
 */
export interface PullRequestFact {
  readonly repositoryKey: string;
  readonly number: number;
  /** Emptied by redaction. */
  readonly title: string;
  /** The source's own status. No metric reads it; it is what makes the stored
   * record answerable by hand, and `mergedAtMs` alone cannot separate a closed
   * pull request from an open one. */
  readonly state: PullRequestState;
  /** Whether the configured identity opened it. Reviewed pull requests opened by
   * somebody else are stored for their title and carry `false`; no other person's
   * login is published. */
  readonly authoredByViewer: boolean;
  readonly createdAtMs: number;
  readonly mergedAtMs: number | null;
  readonly updatedAtMs: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  /** Kept even for a redacted repository: it is how a squash commit is recognised
   * as belonging to a linked issue, and commit SHAs are published regardless. */
  readonly mergeCommitSha: string | null;
  /** Nulled by redaction. */
  readonly sourceUrl: string | null;
  readonly recordedAt: string;
}

/**
 * A review the user submitted. Its own source id is published because, unlike a
 * commit or a pull request, a review has no natural key: two rounds on one pull
 * request are two separate facts.
 */
export interface ReviewFact {
  readonly sourceId: string;
  readonly repositoryKey: string;
  readonly pullRequestNumber: number;
  readonly state: string;
  readonly submittedAtMs: number;
  /** Nulled by redaction. */
  readonly sourceUrl: string | null;
  readonly recordedAt: string;
}

/**
 * A Linear issue that reached a completed state. Keyed on the Linear id so an issue
 * that moves team — keeping its id and changing its identifier — updates rather than
 * duplicating, exactly as the local store handles it.
 */
export interface LinearIssueFact {
  readonly sourceId: string;
  /** `BOS-2422`, upper case. The join key for every link below. */
  readonly identifier: string;
  /** Emptied by redaction. */
  readonly title: string;
  readonly stateName: string;
  readonly stateType: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly completedAtMs: number | null;
  readonly teamKey: string | null;
  /** Nulled by redaction. */
  readonly sourceUrl: string | null;
  readonly recordedAt: string;
}

/**
 * A pull request naming a synced issue in its title or source branch.
 *
 * Links are published rather than recomputed because the strings the link was read
 * from — the title and the branch name — are exactly what redaction removes. The
 * evidence is retained so a link can still be checked by hand.
 */
export interface PullRequestIssueLinkFact {
  readonly repositoryKey: string;
  readonly pullRequestNumber: number;
  readonly issueIdentifier: string;
  readonly via: readonly PullRequestLinkEvidence[];
}

/**
 * A commit whose subject names a synced issue.
 *
 * Only subject evidence is published. The other kind of commit link — a squash
 * commit inheriting its pull request's issues — is derived at query time from the
 * pull request links, because whether it applies depends on the window being asked
 * about, not on the commit.
 */
export interface CommitIssueLinkFact {
  readonly repositoryKey: string;
  readonly sha: string;
  readonly issueIdentifier: string;
  readonly via: Extract<CommitLinkEvidence, "commit_subject">;
}

/**
 * What the collector knows that is not a record: who it collected as, how the last
 * run went, and the zone its calendar days are bucketed in.
 *
 * These are publication-level, not per-record, and they are the reason the hosted
 * dashboard can reproduce the local report's warnings instead of inventing its own.
 */
export interface CollectorFacts {
  /** The zone every `RepositoryDayFact.day` was bucketed in, and the zone a hosted
   * window must be built with for those days to line up. */
  readonly timeZone: string;
  readonly identity: {
    readonly githubLogin: string | null;
    /** Emptied by redaction; the dashboard only ever displays this locally. */
    readonly gitEmails: readonly string[];
    /** Survives redaction, because "no git emails configured" is a warning the
     * hosted dashboard has to be able to repeat without holding the addresses. */
    readonly gitEmailsConfigured: boolean;
  };
  readonly sync: {
    readonly lastRunAt: string | null;
    readonly status: string | null;
    readonly since: string | null;
    /** Diagnostics from the last run, with local paths already removed. */
    readonly warnings: readonly string[];
  };
  readonly linearSyncStatus: LinearDataStatus;
}

/**
 * Everything a metric query needs, from either store.
 *
 * Each list may be a superset of the window being summarised: `metrics/summary.ts`
 * filters by timestamp itself. That is what lets one collection over the whole
 * published range answer 7, 30 and 90 days, and it is why a hosted range the
 * collector never computed produces the same numbers as a local one.
 */
export interface LedgerFacts {
  readonly collector: CollectorFacts;
  readonly repositories: readonly RepositoryFact[];
  readonly repositoryDays: readonly RepositoryDayFact[];
  readonly commits: readonly CommitFact[];
  readonly pullRequests: readonly PullRequestFact[];
  readonly reviews: readonly ReviewFact[];
  readonly linearIssues: readonly LinearIssueFact[];
  readonly pullRequestLinks: readonly PullRequestIssueLinkFact[];
  readonly commitLinks: readonly CommitIssueLinkFact[];
}

/** `new Date(ms).toISOString()`, or `""` for an absent timestamp. */
export function factIso(ms: number | null): string {
  return ms === null ? "" : new Date(ms).toISOString();
}

/** The key a pull request fact, review and link all join on. */
export function pullRequestFactKey(repositoryKey: string, number: number): string {
  return `${repositoryKey}#${number}`;
}
