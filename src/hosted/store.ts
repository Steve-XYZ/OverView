/**
 * What the hosted routes are allowed to ask of storage.
 *
 * Every method that touches user-owned rows takes the user id, so scoping is a
 * property of the query rather than something each route remembers to apply. There
 * is no "read any snapshot" or "delete any token" method to call by mistake.
 */

import type { PublicationEnvelope } from "../publish/publish.ts";

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
  readonly publication: PublicationEnvelope;
}

export interface PublishOutcome {
  readonly publishedAt: string;
  readonly alreadyCurrent: boolean;
}

export interface HostedStore {
  /** Creates the account on first sign-in; afterwards only refreshes a renamed login. */
  upsertUser(githubUserId: number, githubLogin: string): Promise<HostedUser>;
  findUser(userId: string): Promise<HostedUser | null>;
  createToken(userId: string, name: string, hash: string, prefix: string): Promise<CollectorTokenRecord>;
  listTokens(userId: string): Promise<readonly CollectorTokenRecord[]>;
  /** Scoped by owner: a token id belonging to another user must not be deleted. */
  deleteToken(userId: string, tokenId: string): Promise<boolean>;
  /** Resolves a presented collector token to the single account that owns it. */
  findUserByTokenHash(hash: string): Promise<HostedUser | null>;
  putSnapshot(userId: string, publication: PublicationEnvelope): Promise<PublishOutcome>;
  getSnapshot(userId: string): Promise<StoredSnapshot | null>;
}
