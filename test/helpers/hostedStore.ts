/**
 * An in-memory `HostedStore` so the hosted routes can be exercised without Postgres.
 *
 * It mirrors the ownership rules the Neon implementation states in SQL: a token is
 * deleted only when the id and the owner both match, and snapshots are keyed by user.
 * It proves the route layer, not the SQL.
 */

import type {
  CollectorTokenRecord,
  HostedStore,
  HostedUser,
  PublishOutcome,
  StoredSnapshot,
} from "../../src/hosted/store.ts";
import type { PublicationEnvelope } from "../../src/publish/publish.ts";

interface StoredToken {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly prefix: string;
  readonly hash: string;
  readonly createdAt: string;
  lastUsedAt: string | null;
}

export interface MemoryStore extends HostedStore {
  /** Every value the store has ever persisted, for leak assertions. */
  serialized(): string;
}

export function memoryStore(): MemoryStore {
  const users = new Map<string, HostedUser>();
  const byGithubId = new Map<number, string>();
  const tokens = new Map<string, StoredToken>();
  const snapshots = new Map<string, StoredSnapshot>();
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
      return Promise.resolve(true);
    },

    findUserByTokenHash(hash: string): Promise<HostedUser | null> {
      const token = [...tokens.values()].find((candidate) => candidate.hash === hash);
      if (token === undefined) return Promise.resolve(null);
      token.lastUsedAt = stamp();
      return Promise.resolve(users.get(token.userId) ?? null);
    },

    putSnapshot(userId: string, publication: PublicationEnvelope): Promise<PublishOutcome> {
      const current = snapshots.get(userId);
      if (current !== undefined && current.publication.publicationId === publication.publicationId) {
        return Promise.resolve({ publishedAt: current.publishedAt, alreadyCurrent: true });
      }
      const publishedAt = stamp();
      snapshots.set(userId, { publishedAt, publication });
      return Promise.resolve({ publishedAt, alreadyCurrent: false });
    },

    getSnapshot(userId: string): Promise<StoredSnapshot | null> {
      return Promise.resolve(snapshots.get(userId) ?? null);
    },

    serialized(): string {
      return JSON.stringify({
        users: [...users.values()],
        tokens: [...tokens.values()],
        snapshots: [...snapshots.entries()],
      });
    },
  };
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
