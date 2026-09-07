/**
 * The Neon-backed `HostedStore`. Schema is created on first use, as before, so a
 * fresh deployment needs no migration step.
 *
 * The pre-account `overview_published_snapshot` table is deliberately left alone.
 * It is neither read nor dropped here; publishing once under an account repopulates
 * the user-scoped table.
 */

import { neon } from "@neondatabase/serverless";
import type { PublicationEnvelope } from "../publish/publish.ts";
import type {
  CollectorTokenRecord,
  HostedStore,
  HostedUser,
  PublishOutcome,
  StoredSnapshot,
} from "./store.ts";

export const DATABASE_URL_ENV = "DATABASE_URL";

interface UserRow {
  readonly id: string;
  readonly github_user_id: string | number;
  readonly github_login: string;
}

interface TokenRow {
  readonly id: string;
  readonly name: string;
  readonly token_prefix: string;
  readonly created_at: string | Date;
  readonly last_used_at: string | Date | null;
}

interface SnapshotRow {
  readonly published_at: string | Date;
  readonly snapshot: unknown;
}

let schemaReady: Promise<void> | null = null;

export function neonStore(): HostedStore {
  return {
    async upsertUser(githubUserId: number, githubLogin: string): Promise<HostedUser> {
      const sql = await ready();
      const rows = await sql`
        INSERT INTO overview_user (id, github_user_id, github_login)
        VALUES (${crypto.randomUUID()}, ${githubUserId}, ${githubLogin})
        ON CONFLICT (github_user_id) DO UPDATE SET github_login = EXCLUDED.github_login
        RETURNING id, github_user_id, github_login
      ` as unknown as readonly UserRow[];
      const row = rows[0];
      if (row === undefined) throw new Error("The account could not be read after its upsert.");
      return toUser(row);
    },

    async findUser(userId: string): Promise<HostedUser | null> {
      const sql = await ready();
      const rows = await sql`
        SELECT id, github_user_id, github_login FROM overview_user WHERE id = ${userId}
      ` as unknown as readonly UserRow[];
      const row = rows[0];
      return row === undefined ? null : toUser(row);
    },

    async createToken(
      userId: string,
      name: string,
      hash: string,
      prefix: string,
    ): Promise<CollectorTokenRecord> {
      const sql = await ready();
      const rows = await sql`
        INSERT INTO overview_collector_token (id, user_id, name, token_prefix, token_hash)
        VALUES (${crypto.randomUUID()}, ${userId}, ${name}, ${prefix}, ${hash})
        RETURNING id, name, token_prefix, created_at, last_used_at
      ` as unknown as readonly TokenRow[];
      const row = rows[0];
      if (row === undefined) throw new Error("The collector token could not be read after its insert.");
      return toToken(row);
    },

    async listTokens(userId: string): Promise<readonly CollectorTokenRecord[]> {
      const sql = await ready();
      const rows = await sql`
        SELECT id, name, token_prefix, created_at, last_used_at
        FROM overview_collector_token
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
      ` as unknown as readonly TokenRow[];
      return rows.map(toToken);
    },

    async deleteToken(userId: string, tokenId: string): Promise<boolean> {
      const sql = await ready();
      const rows = await sql`
        DELETE FROM overview_collector_token
        WHERE id = ${tokenId} AND user_id = ${userId}
        RETURNING id
      ` as unknown as readonly { readonly id: string }[];
      return rows.length > 0;
    },

    async findUserByTokenHash(hash: string): Promise<HostedUser | null> {
      const sql = await ready();
      const rows = await sql`
        WITH used AS (
          UPDATE overview_collector_token SET last_used_at = NOW()
          WHERE token_hash = ${hash}
          RETURNING user_id
        )
        SELECT u.id, u.github_user_id, u.github_login
        FROM used JOIN overview_user u ON u.id = used.user_id
      ` as unknown as readonly UserRow[];
      const row = rows[0];
      return row === undefined ? null : toUser(row);
    },

    async putSnapshot(userId: string, publication: PublicationEnvelope): Promise<PublishOutcome> {
      const sql = await ready();
      const rows = await sql`
        INSERT INTO overview_user_snapshot (
          user_id, schema_version, publication_id, published_at, snapshot
        ) VALUES (
          ${userId},
          ${publication.schemaVersion},
          ${publication.publicationId},
          NOW(),
          CAST(${JSON.stringify(publication)} AS jsonb)
        )
        ON CONFLICT (user_id) DO UPDATE SET
          schema_version = EXCLUDED.schema_version,
          publication_id = EXCLUDED.publication_id,
          published_at = EXCLUDED.published_at,
          snapshot = EXCLUDED.snapshot
        WHERE overview_user_snapshot.publication_id <> EXCLUDED.publication_id
        RETURNING published_at
      ` as unknown as readonly Pick<SnapshotRow, "published_at">[];

      if (rows[0] !== undefined) {
        return { publishedAt: toIso(rows[0].published_at), alreadyCurrent: false };
      }
      const current = await sql`
        SELECT published_at FROM overview_user_snapshot WHERE user_id = ${userId}
      ` as unknown as readonly Pick<SnapshotRow, "published_at">[];
      const row = current[0];
      if (row === undefined) throw new Error("The published snapshot could not be read after its upsert.");
      return { publishedAt: toIso(row.published_at), alreadyCurrent: true };
    },

    async getSnapshot(userId: string): Promise<StoredSnapshot | null> {
      const sql = await ready();
      const rows = await sql`
        SELECT published_at, snapshot FROM overview_user_snapshot WHERE user_id = ${userId}
      ` as unknown as readonly SnapshotRow[];
      const row = rows[0];
      if (row === undefined) return null;
      return {
        publishedAt: toIso(row.published_at),
        publication: row.snapshot as PublicationEnvelope,
      };
    },
  };
}

function database(): ReturnType<typeof neon> {
  const connectionString = process.env[DATABASE_URL_ENV];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error(`${DATABASE_URL_ENV} is not configured.`);
  }
  return neon(connectionString);
}

async function ready(): Promise<ReturnType<typeof neon>> {
  await ensureSchema();
  return database();
}

function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const sql = database();
    await sql`
      CREATE TABLE IF NOT EXISTS overview_user (
        id text PRIMARY KEY,
        github_user_id bigint NOT NULL UNIQUE,
        github_login text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS overview_collector_token (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES overview_user(id) ON DELETE CASCADE,
        name text NOT NULL,
        token_prefix text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        last_used_at timestamptz
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS overview_collector_token_user_idx
        ON overview_collector_token (user_id)
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS overview_user_snapshot (
        user_id text PRIMARY KEY REFERENCES overview_user(id) ON DELETE CASCADE,
        schema_version integer NOT NULL,
        publication_id text NOT NULL,
        published_at timestamptz NOT NULL,
        snapshot jsonb NOT NULL
      )
    `;
  })().catch((error: unknown) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

function toUser(row: UserRow): HostedUser {
  return {
    id: row.id,
    githubUserId: Number(row.github_user_id),
    githubLogin: row.github_login,
  };
}

function toToken(row: TokenRow): CollectorTokenRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    createdAt: toIso(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : toIso(row.last_used_at),
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
