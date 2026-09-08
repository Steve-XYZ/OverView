/**
 * An in-memory `HostedStore` so the hosted routes can be exercised without Postgres.
 *
 * It mirrors the ownership and lifetime rules the Neon implementation states in SQL:
 * a token is deleted only when the id and the owner both match, every ledger table
 * is keyed by user first, and a publication is authoritative for its coverage range,
 * so records inside it that the publication does not restate are dropped. It proves
 * the route and summary layer, not the SQL.
 */

import type {
  CollectorFacts,
  CommitFact,
  CommitIssueLinkFact,
  LinearIssueFact,
  PullRequestFact,
  PullRequestIssueLinkFact,
  RepositoryDayFact,
  RepositoryFact,
  ReviewFact,
} from "../../src/domain/facts.ts";
import { mergeCollectors } from "../../src/hosted/store.ts";
import type {
  CollectorPrincipal,
  CollectorTokenRecord,
  HostedStore,
  HostedUser,
  LedgerRange,
  LedgerRecords,
  PublishOutcome,
  StoredLedgerHead,
  StoredSnapshot,
} from "../../src/hosted/store.ts";
import type {
  LedgerPublication,
  PublicationCoverage,
  PublicationEnvelope,
} from "../../src/publish/publish.ts";

interface StoredToken {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly prefix: string;
  readonly hash: string;
  readonly createdAt: string;
  lastUsedAt: string | null;
}

/** A record, the collector that claimed it, and the publication that restated it. */
interface Stamped<T> {
  readonly collectorId: string;
  readonly publicationId: string;
  readonly record: T;
}

type Table<T> = Map<string, Stamped<T>>;

interface CollectorRow {
  readonly collectorId: string;
  readonly publicationId: string;
  readonly publishedAt: string;
  readonly collector: CollectorFacts;
}

interface UserLedger {
  /** One row per collector, as the Neon table is keyed. */
  readonly collectors: Map<string, CollectorRow>;
  readonly repositories: Table<RepositoryFact>;
  readonly repositoryDays: Table<RepositoryDayFact>;
  readonly commits: Table<CommitFact>;
  readonly pullRequests: Table<PullRequestFact>;
  readonly reviews: Table<ReviewFact>;
  readonly linearIssues: Table<LinearIssueFact>;
  readonly pullRequestLinks: Table<PullRequestIssueLinkFact>;
  readonly commitLinks: Table<CommitIssueLinkFact>;
}

export interface MemoryStore extends HostedStore {
  /** Every value the store has ever persisted, for leak assertions. */
  serialized(): string;
  /** Row counts per ledger table, for the whole account or one collector. */
  ledgerCounts(userId: string, collectorId?: string): Readonly<Record<string, number>>;
}

export function memoryStore(): MemoryStore {
  const users = new Map<string, HostedUser>();
  const byGithubId = new Map<number, string>();
  const tokens = new Map<string, StoredToken>();
  const snapshots = new Map<string, StoredSnapshot>();
  const ledgers = new Map<string, UserLedger>();
  // Publication ids per account, tracked the way the stored column is.
  const publishedId = new Map<string, string>();
  let clock = Date.parse("2026-09-05T09:00:00.000Z");
  const stamp = (): string => new Date((clock += 1_000)).toISOString();

  return {
    upsertUser(githubUserId: number, githubLogin: string): Promise<HostedUser> {
      const existingId = byGithubId.get(githubUserId);
      if (existingId !== undefined) {
        const updated: HostedUser = { id: existingId, githubUserId, githubLogin };
        users.set(existingId, updated);
        return Promise.resolve(updated);
      }
      const user: HostedUser = { id: crypto.randomUUID(), githubUserId, githubLogin };
      users.set(user.id, user);
      byGithubId.set(githubUserId, user.id);
      return Promise.resolve(user);
    },

    findUser(userId: string): Promise<HostedUser | null> {
      return Promise.resolve(users.get(userId) ?? null);
    },

    createToken(userId: string, name: string, hash: string, prefix: string): Promise<CollectorTokenRecord> {
      const token: StoredToken = {
        id: crypto.randomUUID(),
        userId,
        name,
        prefix,
        hash,
        createdAt: stamp(),
        lastUsedAt: null,
      };
      tokens.set(token.id, token);
      return Promise.resolve(toRecord(token));
    },

    listTokens(userId: string): Promise<readonly CollectorTokenRecord[]> {
      return Promise.resolve(
        [...tokens.values()]
          .filter((token) => token.userId === userId)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map(toRecord),
      );
    },

    deleteToken(userId: string, tokenId: string): Promise<boolean> {
      const token = tokens.get(tokenId);
      if (token === undefined || token.userId !== userId) return Promise.resolve(false);
      tokens.delete(tokenId);
      // The facts it published stay; its diagnostics stop speaking for the account.
      ledgers.get(userId)?.collectors.delete(tokenId);
      return Promise.resolve(true);
    },

    findCollectorByTokenHash(hash: string): Promise<CollectorPrincipal | null> {
      const token = [...tokens.values()].find((candidate) => candidate.hash === hash);
      if (token === undefined) return Promise.resolve(null);
      token.lastUsedAt = stamp();
      const user = users.get(token.userId);
      if (user === undefined) return Promise.resolve(null);
      return Promise.resolve({ user, collectorId: token.id });
    },

    putSnapshot(userId: string, publication: PublicationEnvelope): Promise<PublishOutcome> {
      const current = snapshots.get(userId);
      if (current !== undefined && publishedId.get(userId) === publication.publicationId) {
        return Promise.resolve({ publishedAt: current.publishedAt, alreadyCurrent: true });
      }
      const publishedAt = stamp();
      snapshots.set(userId, { publishedAt, snapshots: publication.snapshots });
      publishedId.set(userId, publication.publicationId);
      return Promise.resolve({ publishedAt, alreadyCurrent: false });
    },

    getSnapshot(userId: string): Promise<StoredSnapshot | null> {
      return Promise.resolve(snapshots.get(userId) ?? null);
    },

    putLedger(
      userId: string,
      collectorId: string,
      publication: LedgerPublication,
    ): Promise<PublishOutcome> {
      const ledger = ledgers.get(userId) ?? emptyLedger();
      const previous = ledger.collectors.get(collectorId);
      const { publicationId: id, coverage, facts } = publication;
      const alreadyCurrent = previous !== undefined && previous.publicationId === id;
      // Held steady when nothing changed, so a repeat publication is invisible even
      // though the write still runs and re-establishes this collector's ownership.
      const publishedAt = alreadyCurrent ? previous.publishedAt : stamp();

      ledger.collectors.set(collectorId, {
        collectorId,
        publicationId: id,
        publishedAt,
        collector: facts.collector,
      });

      const scope = { collectorId, publicationId: id };
      apply(ledger.repositories, facts.repositories, (fact) => fact.key, scope, () => false);
      dropUnclaimedRepositories(ledger, scope);
      cascadeToPublishedRepositories(ledger, scope);

      apply(
        ledger.repositoryDays,
        facts.repositoryDays,
        (fact) => `${fact.repositoryKey} ${fact.day}`,
        scope,
        (fact) => fact.day >= coverage.fromDay && fact.day <= coverage.toDay,
      );
      apply(ledger.commits, facts.commits, (fact) => fact.sha, scope, (fact) =>
        within(fact.authoredAtMs, coverage),
      );
      apply(
        ledger.pullRequests,
        facts.pullRequests,
        (fact) => `${fact.repositoryKey}#${fact.number}`,
        scope,
        (fact) =>
          within(fact.createdAtMs, coverage) ||
          within(fact.mergedAtMs, coverage) ||
          within(fact.updatedAtMs, coverage),
      );
      apply(ledger.reviews, facts.reviews, (fact) => fact.sourceId, scope, (fact) =>
        within(fact.submittedAtMs, coverage),
      );
      apply(ledger.linearIssues, facts.linearIssues, (fact) => fact.sourceId, scope, (fact) =>
        within(fact.completedAtMs, coverage),
      );
      applyLinks(
        ledger.pullRequestLinks,
        facts.pullRequestLinks,
        (fact) => `${fact.repositoryKey}#${fact.pullRequestNumber}|${fact.issueIdentifier}`,
        (fact) => `${fact.repositoryKey}#${fact.pullRequestNumber}`,
        ledger.pullRequests,
        scope,
      );
      applyLinks(
        ledger.commitLinks,
        facts.commitLinks,
        (fact) => `${fact.sha}|${fact.issueIdentifier}`,
        (fact) => fact.sha,
        ledger.commits,
        scope,
      );

      ledgers.set(userId, ledger);
      // The snapshots travel with the facts, so the fallback stays current too.
      snapshots.set(userId, { publishedAt, snapshots: publication.snapshots });
      publishedId.set(userId, id);
      return Promise.resolve({ publishedAt, alreadyCurrent });
    },

    getLedgerHead(userId: string): Promise<StoredLedgerHead | null> {
      const ledger = ledgers.get(userId);
      if (ledger === undefined || ledger.collectors.size === 0) return Promise.resolve(null);
      const rows = [...ledger.collectors.values()].sort(
        (left, right) =>
          right.publishedAt.localeCompare(left.publishedAt) ||
          left.collectorId.localeCompare(right.collectorId),
      );
      const newest = rows[0];
      if (newest === undefined) return Promise.resolve(null);
      return Promise.resolve({
        publishedAt: newest.publishedAt,
        collector: mergeCollectors(rows.map((row) => row.collector)),
      });
    },

    readLedgerRecords(userId: string, range: LedgerRange): Promise<LedgerRecords> {
      const ledger = ledgers.get(userId);
      if (ledger === undefined) {
        return Promise.resolve({
          repositories: [],
          repositoryDays: [],
          commits: [],
          pullRequests: [],
          reviews: [],
          linearIssues: [],
          pullRequestLinks: [],
          commitLinks: [],
        });
      }

      const reviews = records(ledger.reviews).filter((review) =>
        inRange(review.submittedAtMs, range),
      );
      const reviewed = new Set(
        reviews.map((review) => `${review.repositoryKey}#${review.pullRequestNumber}`),
      );
      const merged = records(ledger.pullRequests).filter(
        (pr) => pr.authoredByViewer && inRange(pr.mergedAtMs, range),
      );
      const mergedKeys = new Set(merged.map((pr) => `${pr.repositoryKey}#${pr.number}`));
      const commits = records(ledger.commits).filter((commit) =>
        inRange(commit.authoredAtMs, range),
      );
      const shas = new Set(commits.map((commit) => commit.sha));

      return Promise.resolve({
        repositories: records(ledger.repositories),
        repositoryDays: records(ledger.repositoryDays).filter(
          (day) => day.day >= range.fromDay && day.day <= range.toDay,
        ),
        commits,
        pullRequests: records(ledger.pullRequests).filter(
          (pr) =>
            (pr.authoredByViewer && inRange(pr.createdAtMs, range)) ||
            (pr.authoredByViewer && inRange(pr.mergedAtMs, range)) ||
            reviewed.has(`${pr.repositoryKey}#${pr.number}`),
        ),
        reviews,
        linearIssues: records(ledger.linearIssues).filter((issue) =>
          inRange(issue.completedAtMs, range),
        ),
        pullRequestLinks: records(ledger.pullRequestLinks).filter((link) =>
          mergedKeys.has(`${link.repositoryKey}#${link.pullRequestNumber}`),
        ),
        commitLinks: records(ledger.commitLinks).filter((link) => shas.has(link.sha)),
      });
    },

    serialized(): string {
      return JSON.stringify({
        users: [...users.values()],
        tokens: [...tokens.values()],
        snapshots: [...snapshots.entries()],
        ledgers: [...ledgers.entries()].map(([userId, ledger]) => [
          userId,
          {
            collectors: [...ledger.collectors.values()],
            repositories: records(ledger.repositories),
            repositoryDays: records(ledger.repositoryDays),
            commits: records(ledger.commits),
            pullRequests: records(ledger.pullRequests),
            reviews: records(ledger.reviews),
            linearIssues: records(ledger.linearIssues),
            pullRequestLinks: records(ledger.pullRequestLinks),
            commitLinks: records(ledger.commitLinks),
          },
        ]),
      });
    },

    ledgerCounts(userId: string, collectorId?: string): Readonly<Record<string, number>> {
      const ledger = ledgers.get(userId);
      if (ledger === undefined) return {};
      const size = (table: Table<unknown>): number =>
        collectorId === undefined
          ? table.size
          : [...table.values()].filter((stamped) => stamped.collectorId === collectorId).length;
      return {
        repositories: size(ledger.repositories),
        repositoryDays: size(ledger.repositoryDays),
        commits: size(ledger.commits),
        pullRequests: size(ledger.pullRequests),
        reviews: size(ledger.reviews),
        linearIssues: size(ledger.linearIssues),
        pullRequestLinks: size(ledger.pullRequestLinks),
        commitLinks: size(ledger.commitLinks),
      };
    },
  };
}

function emptyLedger(): UserLedger {
  return {
    collectors: new Map(),
    repositories: new Map(),
    repositoryDays: new Map(),
    commits: new Map(),
    pullRequests: new Map(),
    reviews: new Map(),
    linearIssues: new Map(),
    pullRequestLinks: new Map(),
    commitLinks: new Map(),
  };
}

/** Which collector is publishing, and under which publication id. */
interface Scope {
  readonly collectorId: string;
  readonly publicationId: string;
}

/**
 * Upsert what the publication restates, then drop what this collector left out
 * inside coverage. Another collector's records are never candidates for deletion.
 */
function apply<T>(
  table: Table<T>,
  incoming: readonly T[],
  key: (record: T) => string,
  scope: Scope,
  inCoverage: (record: T) => boolean,
): void {
  for (const record of incoming) table.set(key(record), { ...scope, record });
  for (const [existing, stamped] of [...table]) {
    if (stamped.collectorId !== scope.collectorId) continue;
    if (stamped.publicationId !== scope.publicationId && inCoverage(stamped.record)) {
      table.delete(existing);
    }
  }
}

/**
 * A link lives and dies with the record it belongs to: it goes when that record was
 * restated without it, and it goes when the record is no longer there at all.
 */
function applyLinks<T, P>(
  table: Table<T>,
  incoming: readonly T[],
  key: (record: T) => string,
  parentKey: (record: T) => string,
  parents: Table<P>,
  scope: Scope,
): void {
  for (const record of incoming) table.set(key(record), { ...scope, record });
  for (const [existing, stamped] of [...table]) {
    if (stamped.collectorId !== scope.collectorId) continue;
    const parent = parents.get(parentKey(stamped.record));
    if (parent === undefined) {
      table.delete(existing);
      continue;
    }
    if (stamped.publicationId === scope.publicationId) continue;
    if (parent.publicationId === scope.publicationId) table.delete(existing);
  }
}

/**
 * A repository this collector stopped watching, unless another collector still has
 * facts filed under it.
 */
function dropUnclaimedRepositories(ledger: UserLedger, scope: Scope): void {
  const referencedElsewhere = (repositoryKey: string): boolean =>
    [...ledger.commits.values(), ...ledger.pullRequests.values()].some(
      (stamped) =>
        stamped.collectorId !== scope.collectorId &&
        stamped.record.repositoryKey === repositoryKey,
    );

  for (const [key, stamped] of [...ledger.repositories]) {
    if (stamped.collectorId !== scope.collectorId) continue;
    if (stamped.publicationId === scope.publicationId) continue;
    if (referencedElsewhere(stamped.record.key)) continue;
    ledger.repositories.delete(key);
  }
}

/** This collector's facts for repositories its publication no longer names. */
function cascadeToPublishedRepositories(ledger: UserLedger, scope: Scope): void {
  const published = new Set(
    [...ledger.repositories.values()]
      .filter((stamped) => stamped.publicationId === scope.publicationId)
      .map((stamped) => stamped.record.key),
  );
  const drop = <T extends { readonly repositoryKey: string }>(table: Table<T>): void => {
    for (const [key, stamped] of [...table]) {
      if (stamped.collectorId !== scope.collectorId) continue;
      if (!published.has(stamped.record.repositoryKey)) table.delete(key);
    }
  };
  drop(ledger.repositoryDays);
  drop(ledger.commits);
  drop(ledger.pullRequests);
  drop(ledger.reviews);
  drop(ledger.pullRequestLinks);
  drop(ledger.commitLinks);
}

function records<T>(table: Table<T>): T[] {
  return [...table.values()].map((stamped) => stamped.record);
}

function within(ms: number | null, coverage: PublicationCoverage): boolean {
  return ms !== null && ms >= coverage.fromMs && ms <= coverage.toMs;
}

function inRange(ms: number | null, range: LedgerRange): boolean {
  return ms !== null && ms >= range.fromMs && ms <= range.toMs;
}

function toRecord(token: StoredToken): CollectorTokenRecord {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
  };
}

/** Turns a `Set-Cookie` value into the `Cookie` header a follow-up request carries. */
export function cookieHeader(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}
