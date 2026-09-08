/** The only path by which local data crosses into the hosted mirror. */

import { createHash } from "node:crypto";
import type { OverviewConfig, RepoConfig } from "../config/config.ts";
import type {
  CollectorFacts,
  CommitFact,
  CommitIssueLinkFact,
  LedgerFacts,
  LinearIssueFact,
  PullRequestFact,
  PullRequestIssueLinkFact,
  RepositoryDayFact,
  RepositoryFact,
  ReviewFact,
} from "../domain/facts.ts";
import { currentTimeZone } from "../domain/time.ts";
import type { ActivitySummary } from "../metrics/summary.ts";
import { buildSummary } from "../metrics/summary.ts";
import { createWindow } from "../metrics/window.ts";
import type { Db } from "../store/db.ts";
import { collectFacts } from "../store/facts.ts";

/** Snapshot-only publication: three pre-computed summaries and nothing else. */
export const PUBLICATION_SCHEMA_VERSION = 1 as const;
/** Snapshots plus the normalized facts they were derived from. */
export const LEDGER_SCHEMA_VERSION = 2 as const;
export const PUBLISH_ENDPOINT_ENV = "OVERVIEW_PUBLISH_URL";
export const PUBLISH_TOKEN_ENV = "OVERVIEW_PUBLISH_TOKEN";
export const PUBLISHED_WINDOWS = [7, 30, 90] as const;

/**
 * A publication is authoritative for its coverage range, and the range must reach
 * back at least as far as the longest window the dashboard offers. Otherwise a
 * hosted 90-day answer would depend on records the publication did not restate.
 */
export const MIN_COVERAGE_DAYS = 90;

/** Vercel caps a function request body below 4.5 MB; stay clear of it. */
export const MAX_PUBLICATION_BYTES = 3_500_000;

/** Per-table record caps, so one publication cannot enqueue an unbounded write. */
const MAX_RECORDS: Readonly<Record<keyof LedgerFacts, number>> = {
  collector: 1,
  repositories: 200,
  repositoryDays: 200_000,
  commits: 200_000,
  pullRequests: 50_000,
  reviews: 50_000,
  linearIssues: 50_000,
  pullRequestLinks: 100_000,
  commitLinks: 200_000,
};

export type WindowKey = "7" | "30" | "90";
export type PublishedSnapshots = Readonly<Record<WindowKey, ActivitySummary>>;

export interface PublicationEnvelope {
  readonly schemaVersion: typeof PUBLICATION_SCHEMA_VERSION;
  readonly publicationId: string;
  readonly snapshots: PublishedSnapshots;
}

/**
 * The range a publication restates in full.
 *
 * Inside it the publication is the whole truth: the hosted ledger upserts what it
 * receives and drops anything it held that the publication did not mention, which
 * is how a rebase or an unassigned issue propagates. Outside it, previously
 * published facts are left alone, so the ledger keeps history the local database
 * has since pruned.
 */
export interface PublicationCoverage {
  readonly fromMs: number;
  readonly toMs: number;
  /** First and last local calendar day, in `collector.timeZone`. */
  readonly fromDay: string;
  readonly toDay: string;
}

export interface LedgerPublication {
  readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  readonly publicationId: string;
  readonly generatedAt: string;
  readonly coverage: PublicationCoverage;
  /** Retained so the previous read path stays available while the ledger is proved. */
  readonly snapshots: PublishedSnapshots;
  readonly facts: LedgerFacts;
}

export interface PublishResult {
  readonly publishedAt: string;
  readonly alreadyCurrent: boolean;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RepositoryRule {
  readonly names: ReadonlySet<string>;
  readonly publishedName: string;
  readonly redacted: boolean;
}

/** How a repository key is published, and whether its detail survives. */
interface PublishedRepository {
  readonly key: string;
  readonly slug: string;
  readonly redacted: boolean;
}

/* ---------------------------------------------------------------- building */

/** Snapshots only, in the shape the pre-ledger hosted mirror accepts. */
export function buildPublication(
  db: Db,
  config: OverviewConfig,
  now: number = Date.now(),
): PublicationEnvelope {
  const snapshots = buildSnapshots(db, config, now, protectedIssues(db, config, now));
  return {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    publicationId: snapshotPublicationId(snapshots),
    snapshots,
  };
}

/**
 * Normalized facts for the covered range, plus the same three snapshots the
 * previous contract carried.
 *
 * The snapshots are computed the way they always were — summarise the local
 * database, then redact the summary — while the facts are redacted first and
 * summarised by the hosted side. Keeping the two derivations independent is what
 * makes a disagreement between them observable rather than hidden.
 */
export function buildLedgerPublication(
  db: Db,
  config: OverviewConfig,
  now: number = Date.now(),
): LedgerPublication {
  const timeZone = currentTimeZone();
  const window = createWindow(coverageDays(config), now, timeZone);
  const coverage: PublicationCoverage = {
    fromMs: window.fromMs,
    toMs: window.toMs,
    fromDay: window.startDayKey,
    toDay: window.endDayKey,
  };

  const collected = collectFacts(
    db,
    { fromMs: coverage.fromMs, toMs: coverage.toMs },
    config.identity,
    timeZone,
  );
  const facts = redactFacts(collected, config);
  const snapshots = buildSnapshots(db, config, now, issuesTouchingRedactedRepositories(collected, config));

  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    publicationId: ledgerPublicationId(coverage, facts),
    generatedAt: new Date(now).toISOString(),
    coverage,
    snapshots,
    facts,
  };
}

/** How far back a publication restates, never less than the longest window. */
export function coverageDays(config: OverviewConfig): number {
  return Math.max(config.sync.sinceDays, MIN_COVERAGE_DAYS);
}

function buildSnapshots(
  db: Db,
  config: OverviewConfig,
  now: number,
  redactedIssues: ReadonlySet<string>,
): PublishedSnapshots {
  return Object.fromEntries(
    PUBLISHED_WINDOWS.map((days) => {
      const summary = buildSummary(db, createWindow(days, now), config.identity);
      return [String(days), redactForPublishing(summary, config, redactedIssues)];
    }),
  ) as unknown as PublishedSnapshots;
}

/** The global Linear rule, for the snapshot-only path that never collects facts. */
function protectedIssues(
  db: Db,
  config: OverviewConfig,
  now: number,
): ReadonlySet<string> {
  const timeZone = currentTimeZone();
  const window = createWindow(coverageDays(config), now, timeZone);
  return issuesTouchingRedactedRepositories(
    collectFacts(db, { fromMs: window.fromMs, toMs: window.toMs }, config.identity, timeZone),
    config,
  );
}

/* --------------------------------------------------------------- redaction */

/**
 * The fact-level egress boundary.
 *
 * Everything a redacted repository contributes is emptied here, before the record
 * is serialized, so the hosted database never holds the string at all. Metrics,
 * repository identifiers, pull request numbers, commit SHAs and issue identifiers
 * are retained, because without them there is no dashboard.
 */
export function redactFacts(facts: LedgerFacts, config: OverviewConfig): LedgerFacts {
  const repository = repositoryResolver(config);
  const redactedIssue = issuesTouchingRedactedRepositories(facts, config);

  return {
    collector: redactCollector(facts.collector, config),
    repositories: facts.repositories.map((repo): RepositoryFact => {
      const rule = repository(repo.key);
      return {
        ...repo,
        key: repo.key.toLowerCase().startsWith("path:") ? rule.key : repo.key,
        slug: rule.slug,
        // A local checkout path is never useful to the hosted dashboard.
        localPath: null,
        ...(rule.redacted ? { defaultRef: null, headSha: null } : {}),
      };
    }),
    repositoryDays: facts.repositoryDays.map((day): RepositoryDayFact => {
      const rule = repository(day.repositoryKey);
      return {
        ...day,
        repositoryKey: rule.key,
        ...(rule.redacted ? { authorEmails: [] } : {}),
      };
    }),
    commits: facts.commits.map((commit): CommitFact => {
      const rule = repository(commit.repositoryKey);
      return {
        ...commit,
        repositoryKey: rule.key,
        ...(rule.redacted ? { subject: "", sourceUrl: null } : {}),
      };
    }),
    pullRequests: facts.pullRequests.map((pr): PullRequestFact => {
      const rule = repository(pr.repositoryKey);
      return {
        ...pr,
        repositoryKey: rule.key,
        ...(rule.redacted ? { title: "", sourceUrl: null } : {}),
      };
    }),
    reviews: facts.reviews.map((review): ReviewFact => {
      const rule = repository(review.repositoryKey);
      return {
        ...review,
        repositoryKey: rule.key,
        ...(rule.redacted ? { sourceUrl: null } : {}),
      };
    }),
    linearIssues: facts.linearIssues.map((issue): LinearIssueFact => ({
      ...issue,
      ...(redactedIssue.has(issue.identifier) ? { title: "", sourceUrl: null } : {}),
    })),
    pullRequestLinks: facts.pullRequestLinks.map(
      (link): PullRequestIssueLinkFact => ({
        ...link,
        repositoryKey: repository(link.repositoryKey).key,
      }),
    ),
    commitLinks: facts.commitLinks.map((link): CommitIssueLinkFact => ({
      ...link,
      repositoryKey: repository(link.repositoryKey).key,
    })),
  };
}

/**
 * Issue identifiers whose title and URL must not be published.
 *
 * The rule is deliberately not window-scoped. A fact is redacted once, when it is
 * published, so "does any of my work on a private repository name this issue"
 * has to be answered over every link rather than over the window that happens to
 * be on screen — otherwise the same title would reach the hosted database as soon
 * as the window moved.
 */
export function issuesTouchingRedactedRepositories(
  facts: LedgerFacts,
  config: OverviewConfig,
): ReadonlySet<string> {
  const repository = repositoryResolver(config);
  const identifiers = new Set<string>();
  if (config.publish.redactLinearDetails) {
    for (const issue of facts.linearIssues) identifiers.add(issue.identifier);
  }
  for (const link of facts.pullRequestLinks) {
    if (repository(link.repositoryKey).redacted) identifiers.add(link.issueIdentifier);
  }
  for (const link of facts.commitLinks) {
    if (repository(link.repositoryKey).redacted) identifiers.add(link.issueIdentifier);
  }
  return identifiers;
}

function redactCollector(collector: CollectorFacts, config: OverviewConfig): CollectorFacts {
  return {
    ...collector,
    identity: {
      ...collector.identity,
      // Email matching is a local diagnostic. Whether any address is configured is
      // published, because the dashboard has to repeat that warning.
      gitEmails: [],
    },
    sync: {
      ...collector.sync,
      warnings: collector.sync.warnings.map((warning) =>
        redactLocalPaths(warning, config.repositories),
      ),
    },
  };
}

/**
 * The summary-level egress boundary, retained for the snapshot path.
 *
 * It returns a new object and never mutates the summary used by the local report or
 * loopback dashboard. `redactedIssues` carries the same global Linear rule the fact
 * path applies, so the two publications agree about which titles are allowed out.
 */
export function redactForPublishing(
  summary: ActivitySummary,
  config: OverviewConfig,
  redactedIssues: ReadonlySet<string> = new Set(),
): ActivitySummary {
  const rules = config.repositories.map(repositoryRule);
  const repository = (name: string): { readonly name: string; readonly redacted: boolean } => {
    const lower = name.toLowerCase();
    const rule = rules.find((candidate) => candidate.names.has(lower));
    if (rule !== undefined) return { name: rule.publishedName, redacted: rule.redacted };
    // A path-backed repository must never disclose its local checkout path, even
    // if it is a stale row no longer represented in the current config.
    if (lower.startsWith("path:")) return { name: "local-repository", redacted: true };
    return { name, redacted: false };
  };

  return {
    ...summary,
    identity: { ...summary.identity, gitEmails: [] },
    landedPullRequests: summary.landedPullRequests.map((pullRequest) => {
      const rule = repository(pullRequest.repository);
      return {
        ...pullRequest,
        repository: rule.name,
        ...(rule.redacted ? { title: "", url: null } : {}),
      };
    }),
    recentCommits: summary.recentCommits.map((commit) => {
      const rule = repository(commit.repository);
      return {
        ...commit,
        repository: rule.name,
        ...(rule.redacted ? { subject: "", url: null } : {}),
      };
    }),
    recentReviews: summary.recentReviews.map((review) => {
      const rule = repository(review.repository);
      return {
        ...review,
        repository: rule.name,
        ...(rule.redacted ? { title: "", url: null } : {}),
      };
    }),
    repositories: summary.repositories.map((status) => {
      const rule = repository(status.slug ?? status.key);
      return {
        ...status,
        key: status.key.startsWith("path:") ? rule.name : status.key,
        slug: rule.name,
        // Local checkout paths are never useful to the hosted dashboard.
        localPath: null,
        ...(rule.redacted
          ? { defaultRef: null, headSha: null, authorEmails: [] }
          : {}),
      };
    }),
    linear: {
      ...summary.linear,
      completedIssues: summary.linear.completedIssues.map((issue) => {
        const pullRequests = issue.pullRequests.map((pullRequest) => {
          const rule = repository(pullRequest.repository);
          return {
            ...pullRequest,
            repository: rule.name,
            ...(rule.redacted ? { title: "", url: null } : {}),
          };
        });
        const commits = issue.commits.map((commit) => {
          const rule = repository(commit.repository);
          return {
            ...commit,
            repository: rule.name,
            ...(rule.redacted ? { subject: "", url: null } : {}),
          };
        });
        const redactIssue =
          config.publish.redactLinearDetails ||
          redactedIssues.has(issue.identifier) ||
          issue.pullRequests.some((entry) => repository(entry.repository).redacted) ||
          issue.commits.some((entry) => repository(entry.repository).redacted);
        return {
          ...issue,
          pullRequests,
          commits,
          ...(redactIssue ? { title: "", url: null } : {}),
        };
      }),
    },
    warnings: summary.warnings.map((warning) => redactLocalPaths(warning, config.repositories)),
  };
}

/** Resolve a stored repository key to how it is published. */
function repositoryResolver(config: OverviewConfig): (repositoryKey: string) => PublishedRepository {
  const rules = config.repositories.map(repositoryRule);
  return (repositoryKey: string): PublishedRepository => {
    const lower = repositoryKey.toLowerCase();
    const rule = rules.find((candidate) => candidate.names.has(lower));
    if (rule !== undefined) {
      return {
        key: lower.startsWith("path:") ? rule.publishedName : repositoryKey,
        slug: rule.publishedName,
        redacted: rule.redacted,
      };
    }
    // A stale path-keyed row no longer in the config still must not leak its path.
    if (lower.startsWith("path:")) {
      return { key: "local-repository", slug: "local-repository", redacted: true };
    }
    return { key: repositoryKey, slug: repositoryKey, redacted: false };
  };
}

function repositoryRule(repo: RepoConfig, index: number): RepositoryRule {
  const key = repo.githubRepo === undefined
    ? `path:${repo.path}`
    : `github:${repo.githubRepo.toLowerCase()}`;
  const publishedName = repo.githubRepo ?? `local-repository-${index + 1}`;
  return {
    names: new Set([key.toLowerCase(), repo.githubRepo?.toLowerCase() ?? key.toLowerCase()]),
    publishedName,
    redacted: repo.hostedDetail === "redacted",
  };
}

function redactLocalPaths(value: string, repositories: readonly RepoConfig[]): string {
  return repositories.reduce(
    (redacted, repo) => redacted.replaceAll(repo.path, "[local path]"),
    value,
  );
}

/* ------------------------------------------------------------------ upload */

export async function publishToHost(
  endpoint: string,
  token: string,
  publication: PublicationEnvelope | LedgerPublication,
  fetchImpl: FetchLike = fetch,
): Promise<PublishResult> {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("The publish endpoint must use HTTPS.");
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("The publish endpoint must not contain credentials.");
  }
  if (token.length < 32) throw new Error(`${PUBLISH_TOKEN_ENV} must be at least 32 characters.`);
  if (!isPublicationEnvelope(publication) && !isLedgerPublication(publication)) {
    throw new Error("The publication does not match its schema or content id.");
  }

  const body = JSON.stringify(publication);
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_PUBLICATION_BYTES) {
    throw new Error(
      `The publication is ${Math.round(bytes / 1000)} kB, over the ` +
        `${Math.round(MAX_PUBLICATION_BYTES / 1000)} kB limit. Lower sync.sinceDays to publish a ` +
        "shorter history.",
    );
  }

  const response = await fetchImpl(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "overview-publisher/2",
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = isRecord(parsed) && typeof parsed["error"] === "string"
      ? parsed["error"]
      : `HTTP ${response.status}`;
    throw new Error(`Publish failed: ${message}`);
  }
  if (
    !isRecord(parsed) ||
    typeof parsed["publishedAt"] !== "string" ||
    typeof parsed["alreadyCurrent"] !== "boolean"
  ) {
    throw new Error("Publish failed: the hosted application returned an invalid response.");
  }
  return { publishedAt: parsed["publishedAt"], alreadyCurrent: parsed["alreadyCurrent"] };
}

/* -------------------------------------------------------------- validation */

export function isPublicationEnvelope(value: unknown): value is PublicationEnvelope {
  if (!isRecord(value)) return false;
  if (value["schemaVersion"] !== PUBLICATION_SCHEMA_VERSION) return false;
  if (!isContentId(value["publicationId"])) return false;
  if (!hasOnlyKeys(value, ["schemaVersion", "publicationId", "snapshots"])) return false;
  if (!isSnapshots(value["snapshots"])) return false;
  return value["publicationId"] === snapshotPublicationId(value["snapshots"]);
}

/**
 * The hosted trust boundary for a ledger publication.
 *
 * A collector token proves who is publishing, not that the payload is well formed,
 * and these records go straight into typed columns. Every field is therefore
 * checked before any of it reaches the database, and the content id must match the
 * facts so a truncated or spliced body is rejected rather than half-stored.
 */
export function isLedgerPublication(value: unknown): value is LedgerPublication {
  if (!isRecord(value)) return false;
  if (value["schemaVersion"] !== LEDGER_SCHEMA_VERSION) return false;
  if (!isContentId(value["publicationId"])) return false;
  if (
    !hasOnlyKeys(value, [
      "schemaVersion",
      "publicationId",
      "generatedAt",
      "coverage",
      "snapshots",
      "facts",
    ])
  ) {
    return false;
  }
  if (!isText(value["generatedAt"])) return false;
  if (!isSnapshots(value["snapshots"])) return false;

  const coverage = readCoverage(value["coverage"]);
  if (coverage === null) return false;

  const facts = value["facts"];
  if (!isLedgerFacts(facts)) return false;
  return value["publicationId"] === ledgerPublicationId(coverage, facts);
}

function readCoverage(value: unknown): PublicationCoverage | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["fromMs", "toMs", "fromDay", "toDay"])) return null;
  const fromMs = value["fromMs"];
  const toMs = value["toMs"];
  const fromDay = value["fromDay"];
  const toDay = value["toDay"];
  if (!isEpochMs(fromMs) || !isEpochMs(toMs) || fromMs > toMs) return null;
  if (!isDayKey(fromDay) || !isDayKey(toDay) || fromDay > toDay) return null;
  return { fromMs, toMs, fromDay, toDay };
}

function isLedgerFacts(value: unknown): value is LedgerFacts {
  if (!isRecord(value)) return false;
  const keys = Object.keys(MAX_RECORDS);
  if (!hasOnlyKeys(value, keys)) return false;
  for (const key of keys) {
    if (key === "collector") continue;
    const list = value[key];
    if (!Array.isArray(list)) return false;
    if (list.length > (MAX_RECORDS[key as keyof LedgerFacts] ?? 0)) return false;
  }
  return (
    isCollectorFacts(value["collector"]) &&
    every(value["repositories"], isRepositoryFact) &&
    every(value["repositoryDays"], isRepositoryDayFact) &&
    every(value["commits"], isCommitFact) &&
    every(value["pullRequests"], isPullRequestFact) &&
    every(value["reviews"], isReviewFact) &&
    every(value["linearIssues"], isLinearIssueFact) &&
    every(value["pullRequestLinks"], isPullRequestLinkFact) &&
    every(value["commitLinks"], isCommitLinkFact)
  );
}

function isCollectorFacts(value: unknown): value is CollectorFacts {
  if (!isRecord(value) || !hasOnlyKeys(value, ["timeZone", "identity", "sync", "linearSyncStatus"])) {
    return false;
  }
  const identity = value["identity"];
  const sync = value["sync"];
  return (
    isText(value["timeZone"]) &&
    isLinearStatus(value["linearSyncStatus"]) &&
    isRecord(identity) &&
    hasOnlyKeys(identity, ["githubLogin", "gitEmails", "gitEmailsConfigured"]) &&
    isNullableText(identity["githubLogin"]) &&
    isTextArray(identity["gitEmails"]) &&
    typeof identity["gitEmailsConfigured"] === "boolean" &&
    isRecord(sync) &&
    hasOnlyKeys(sync, ["lastRunAt", "status", "since", "warnings"]) &&
    isNullableText(sync["lastRunAt"]) &&
    isNullableText(sync["status"]) &&
    isNullableText(sync["since"]) &&
    isTextArray(sync["warnings"])
  );
}

function isRepositoryFact(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      "key",
      "slug",
      "localPath",
      "defaultRef",
      "headSha",
      "headCommittedAt",
      "lastSyncedAt",
    ]) &&
    isText(value["key"]) &&
    isNullableText(value["slug"]) &&
    isNullableText(value["defaultRef"]) &&
    isNullableText(value["headSha"]) &&
    isNullableText(value["headCommittedAt"]) &&
    isNullableText(value["lastSyncedAt"]) &&
    // The one field publishing must always have emptied.
    value["localPath"] === null
  );
}

function isRepositoryDayFact(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      "repositoryKey",
      "day",
      "commitsObserved",
      "commitsMatched",
      "authorEmails",
    ]) &&
    isText(value["repositoryKey"]) &&
    isDayKey(value["day"]) &&
    isCount(value["commitsObserved"]) &&
    isCount(value["commitsMatched"]) &&
    isTextArray(value["authorEmails"])
  );
}

function isCommitFact(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      "repositoryKey",
      "sha",
      "authoredAtMs",
      "committedAtMs",
      "subject",
      "additions",
      "deletions",
      "filesChanged",
      "excludedAdditions",
      "excludedDeletions",
      "sourceUrl",
      "recordedAt",
    ]) &&
    isText(value["repositoryKey"]) &&
    isText(value["sha"]) &&
    isEpochMs(value["authoredAtMs"]) &&
    isEpochMs(value["committedAtMs"]) &&
    typeof value["subject"] === "string" &&
    isCount(value["additions"]) &&
    isCount(value["deletions"]) &&
    isCount(value["filesChanged"]) &&
    isCount(value["excludedAdditions"]) &&
    isCount(value["excludedDeletions"]) &&
    isNullableText(value["sourceUrl"]) &&
    isText(value["recordedAt"])
  );
}

function isPullRequestFact(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      "repositoryKey",
      "number",
      "title",
      "state",
      "authoredByViewer",
      "createdAtMs",
      "mergedAtMs",
      "updatedAtMs",
      "additions",
      "deletions",
      "changedFiles",
      "mergeCommitSha",
      "sourceUrl",
      "recordedAt",
    ]) &&
    isText(value["repositoryKey"]) &&
    isCount(value["number"]) &&
    typeof value["title"] === "string" &&
    (value["state"] === "OPEN" || value["state"] === "CLOSED" || value["state"] === "MERGED") &&
    typeof value["authoredByViewer"] === "boolean" &&
    isEpochMs(value["createdAtMs"]) &&
    isNullableEpochMs(value["mergedAtMs"]) &&
    isEpochMs(value["updatedAtMs"]) &&
    isCount(value["additions"]) &&
    isCount(value["deletions"]) &&
    isCount(value["changedFiles"]) &&
    isNullableText(value["mergeCommitSha"]) &&
    isNullableText(value["sourceUrl"]) &&
    isText(value["recordedAt"])
  );
}

function isReviewFact(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      "sourceId",
      "repositoryKey",
      "pullRequestNumber",
      "state",
      "submittedAtMs",
      "sourceUrl",
      "recordedAt",
    ]) &&
    isText(value["sourceId"]) &&
    isText(value["repositoryKey"]) &&
    isCount(value["pullRequestNumber"]) &&
    isText(value["state"]) &&
    isEpochMs(value["submittedAtMs"]) &&
    isNullableText(value["sourceUrl"]) &&
    isText(value["recordedAt"])
  );
}

function isLinearIssueFact(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      "sourceId",
      "identifier",
      "title",
      "stateName",
      "stateType",
      "createdAtMs",
      "updatedAtMs",
      "completedAtMs",
      "teamKey",
      "sourceUrl",
      "recordedAt",
    ]) &&
    isText(value["sourceId"]) &&
    isText(value["identifier"]) &&
    typeof value["title"] === "string" &&
    isText(value["stateName"]) &&
    isText(value["stateType"]) &&
    isEpochMs(value["createdAtMs"]) &&
    isEpochMs(value["updatedAtMs"]) &&
    isNullableEpochMs(value["completedAtMs"]) &&
    isNullableText(value["teamKey"]) &&
    isNullableText(value["sourceUrl"]) &&
    isText(value["recordedAt"])
  );
}

function isPullRequestLinkFact(value: Record<string, unknown>): boolean {
  const via = value["via"];
  return (
    hasOnlyKeys(value, ["repositoryKey", "pullRequestNumber", "issueIdentifier", "via"]) &&
    isText(value["repositoryKey"]) &&
    isCount(value["pullRequestNumber"]) &&
    isText(value["issueIdentifier"]) &&
    Array.isArray(via) &&
    via.length > 0 &&
    via.every((entry) => entry === "pr_title" || entry === "pr_branch")
  );
}

function isCommitLinkFact(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, ["repositoryKey", "sha", "issueIdentifier", "via"]) &&
    isText(value["repositoryKey"]) &&
    isText(value["sha"]) &&
    isText(value["issueIdentifier"]) &&
    // The derived `pr_merge_commit` evidence is never published: it depends on the
    // window being asked about, so accepting it would double-count a squash commit.
    value["via"] === "commit_subject"
  );
}

/* ------------------------------------------------------------- content ids */

/**
 * A content id over the facts, excluding the wall clock.
 *
 * `coverage.toMs` and `generatedAt` move on every run, so a publication that says
 * nothing new would never be recognised as already current if they were included.
 * The covered days are included: a publication for a different range is different
 * work even when its records are identical.
 */
function ledgerPublicationId(coverage: PublicationCoverage, facts: LedgerFacts): string {
  return sha256({
    coverage: { fromMs: coverage.fromMs, fromDay: coverage.fromDay, toDay: coverage.toDay },
    facts,
  });
}

function snapshotPublicationId(snapshots: PublishedSnapshots): string {
  return sha256(
    Object.fromEntries(
      Object.entries(snapshots).map(([days, summary]) => {
        const { generatedAt: _generatedAt, publishedAt: _publishedAt, ...content } = summary;
        const { endIso: _endIso, ...stableWindow } = content.window;
        return [days, { ...content, window: stableWindow }];
      }),
    ),
  );
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/* ----------------------------------------------------------------- guards */

function isSnapshots(value: unknown): value is PublishedSnapshots {
  if (!isRecord(value) || !hasOnlyKeys(value, ["7", "30", "90"])) return false;
  return PUBLISHED_WINDOWS.every((days) => isSummary(value[String(days)], days));
}

function isSummary(value: unknown, days: number): value is ActivitySummary {
  if (!isRecord(value) || typeof value["generatedAt"] !== "string") return false;
  const window = value["window"];
  const totals = value["totals"];
  const linear = value["linear"];
  return isRecord(window) && window["days"] === days &&
    isRecord(totals) && typeof totals["commitsAuthored"] === "number" &&
    Array.isArray(value["daily"]) && Array.isArray(value["landedPullRequests"]) &&
    Array.isArray(value["recentCommits"]) && Array.isArray(value["recentReviews"]) &&
    Array.isArray(value["repositories"]) && isRecord(linear) &&
    Array.isArray(linear["completedIssues"]);
}

function every(
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean,
): boolean {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && predicate(entry));
}

function isContentId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isDayKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2000;
}

function isNullableText(value: unknown): value is string | null {
  return value === null || isText(value);
}

function isTextArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 5000 && value.every((entry) => isText(entry));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNullableEpochMs(value: unknown): value is number | null {
  return value === null || isEpochMs(value);
}

function isLinearStatus(value: unknown): boolean {
  return (
    value === "synced" ||
    value === "missing_key" ||
    value === "skipped" ||
    value === "failed" ||
    value === "unknown"
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
