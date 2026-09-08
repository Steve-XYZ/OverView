/**
 * What the hosted routes are allowed to ask of storage.
 *
 * Every method that touches user-owned rows takes the user id, so scoping is a
 * property of the query rather than something each route remembers to apply. There
 * is no "read any snapshot" or "delete any token" method to call by mistake.
 */

import type { CollectorFacts, LedgerFacts } from "../domain/facts.ts";
import type {
  LedgerPublication,
  PublicationEnvelope,
  PublishedSnapshots,
} from "../publish/publish.ts";

export interface HostedUser {
  readonly id: string;
  readonly githubUserId: number;
  readonly githubLogin: string;
}

export interface CollectorTokenRecord {
  readonly id: string;
  readonly name: string;
  /** The first few characters of the plaintext, for telling your own tokens apart. */
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface StoredSnapshot {
  readonly publishedAt: string;
  readonly snapshots: PublishedSnapshots;
}

export interface PublishOutcome {
  readonly publishedAt: string;
  readonly alreadyCurrent: boolean;
}

/**
 * The account's collector that presented a token.
 *
 * A publication is authoritative only over the facts this collector last wrote, so
 * the credential's own row id is carried from authentication into storage. It is the
 * identity the account already manages on the tokens page; nothing new is minted.
 */
export interface CollectorPrincipal {
  readonly user: HostedUser;
  /** `overview_collector_token.id`. */
  readonly collectorId: string;
}

/**
 * What the account's collectors have published, as one view.
 *
 * An account can run several collectors, each with its own repositories, time zone
 * and Linear configuration. The dashboard shows one page, so the diagnostics are
 * merged: see `mergeCollectors` in the Neon store for the rule each field follows.
 */
export interface StoredLedgerHead {
  /** The most recent publication across the account's collectors. */
  readonly publishedAt: string;
  readonly collector: LedgerFacts["collector"];
}

/**
 * One `CollectorFacts` from every collector on the account, most recent first.
 *
 * The dashboard is one page and these are per machine, so each field takes the
 * answer that keeps the page truthful rather than the answer of whichever collector
 * published last:
 *
 *  - the newest publication decides the time zone, because its calendar days are the
 *    ones the freshest records were bucketed in;
 *  - a git address configured anywhere means commits are being attributed, so that
 *    warning is suppressed if any collector has one;
 *  - the sync line reports the most recent run across collectors, with its own
 *    status and window;
 *  - Linear counts as synced if any collector syncs it, because its issues really
 *    are in the ledger; a machine without `LINEAR_API_KEY` must not blank the
 *    section that another machine filled;
 *  - warnings are the union, so a failing machine is still heard.
 */
export function mergeCollectors(collectors: readonly CollectorFacts[]): CollectorFacts {
  const [newest, ...rest] = collectors;
  if (newest === undefined) throw new Error("A ledger head must have at least one collector.");
  if (rest.length === 0) return newest;

  const newestSync = collectors.reduce((latest, candidate) =>
    (candidate.sync.lastRunAt ?? "") > (latest.sync.lastRunAt ?? "") ? candidate : latest,
  );
  const warnings = [...new Set(collectors.flatMap((collector) => [...collector.sync.warnings]))];

  return {
    timeZone: newest.timeZone,
    identity: {
      githubLogin: newest.identity.githubLogin,
      gitEmails: [],
      gitEmailsConfigured: collectors.some((c) => c.identity.gitEmailsConfigured),
    },
    sync: { ...newestSync.sync, warnings },
    linearSyncStatus: collectors.some((c) => c.linearSyncStatus === "synced")
      ? "synced"
      : newest.linearSyncStatus,
  };
}

/** The records of a ledger, which are read a range at a time. */
export type LedgerRecords = Omit<LedgerFacts, "collector">;

/**
 * A range to read, in both units the ledger indexes on: milliseconds for the
 * record tables, calendar days for the per-day observed volume.
 */
export interface LedgerRange {
  readonly fromMs: number;
  readonly toMs: number;
  readonly fromDay: string;
  readonly toDay: string;
}

export interface HostedStore {
  /** Creates the account on first sign-in; afterwards only refreshes a renamed login. */
  upsertUser(githubUserId: number, githubLogin: string): Promise<HostedUser>;
  findUser(userId: string): Promise<HostedUser | null>;
  createToken(userId: string, name: string, hash: string, prefix: string): Promise<CollectorTokenRecord>;
  listTokens(userId: string): Promise<readonly CollectorTokenRecord[]>;
  /** Scoped by owner: a token id belonging to another user must not be deleted. */
  deleteToken(userId: string, tokenId: string): Promise<boolean>;
  /** Resolves a presented collector token to the account and credential that own it. */
  findCollectorByTokenHash(hash: string): Promise<CollectorPrincipal | null>;
  putSnapshot(userId: string, publication: PublicationEnvelope): Promise<PublishOutcome>;
  getSnapshot(userId: string): Promise<StoredSnapshot | null>;
  /**
   * Stores the facts and the snapshots that came with them, or neither.
   *
   * Facts are owned by the account and deduplicated by their source identity, but
   * authority to *remove* one belongs to a single collector: the one that last wrote
   * it. Within the publication's coverage, records this collector restates are
   * updated, and records it previously wrote that this publication no longer mentions
   * are removed. Another collector's records are never touched, so two machines
   * watching different repositories do not delete each other's work. Facts outside
   * coverage are left as history.
   */
  putLedger(
    userId: string,
    collectorId: string,
    publication: LedgerPublication,
  ): Promise<PublishOutcome>;
  /** Null when no collector on the account has published a ledger. */
  getLedgerHead(userId: string): Promise<StoredLedgerHead | null>;
  /** Facts are account-wide: a read merges every collector's records. */
  readLedgerRecords(userId: string, range: LedgerRange): Promise<LedgerRecords>;
}
