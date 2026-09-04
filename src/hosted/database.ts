import { neon } from "@neondatabase/serverless";
import type { PublicationEnvelope } from "../publish/publish.ts";

export const DATABASE_URL_ENV = "DATABASE_URL";

interface SnapshotRow {
  readonly published_at: string | Date;
  readonly snapshot: unknown;
}

let schemaReady: Promise<void> | null = null;

export async function storePublication(
  publication: PublicationEnvelope,
): Promise<{ readonly publishedAt: string; readonly alreadyCurrent: boolean }> {
  const sql = database();
  await ensureSchema();
  const rows = await sql`
    INSERT INTO overview_published_snapshot (
      singleton_id, schema_version, publication_id, published_at, snapshot
    ) VALUES (
      1,
      ${publication.schemaVersion},
      ${publication.publicationId},
      NOW(),
      CAST(${JSON.stringify(publication)} AS jsonb)
    )
    ON CONFLICT (singleton_id) DO UPDATE SET
      schema_version = EXCLUDED.schema_version,
      publication_id = EXCLUDED.publication_id,
      published_at = EXCLUDED.published_at,
      snapshot = EXCLUDED.snapshot
    WHERE overview_published_snapshot.publication_id <> EXCLUDED.publication_id
    RETURNING published_at
  ` as unknown as readonly Pick<SnapshotRow, "published_at">[];

  if (rows[0] !== undefined) {
    return { publishedAt: toIso(rows[0].published_at), alreadyCurrent: false };
  }
  const current = await sql`
    SELECT published_at FROM overview_published_snapshot WHERE singleton_id = 1
  ` as unknown as readonly Pick<SnapshotRow, "published_at">[];
  const row = current[0];
  if (row === undefined) throw new Error("The published snapshot could not be read after its upsert.");
  return { publishedAt: toIso(row.published_at), alreadyCurrent: true };
}

export async function readPublication(): Promise<{
  readonly publishedAt: string;
  readonly publication: PublicationEnvelope;
} | null> {
  const sql = database();
  await ensureSchema();
  const rows = await sql`
    SELECT published_at, snapshot
    FROM overview_published_snapshot
    WHERE singleton_id = 1
  ` as unknown as readonly SnapshotRow[];
  const row = rows[0];
  if (row === undefined) return null;
  return {
    publishedAt: toIso(row.published_at),
    publication: row.snapshot as PublicationEnvelope,
  };
}

function database(): ReturnType<typeof neon> {
  const connectionString = process.env[DATABASE_URL_ENV];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error(`${DATABASE_URL_ENV} is not configured.`);
  }
  return neon(connectionString);
}

function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const sql = database();
    await sql`
      CREATE TABLE IF NOT EXISTS overview_published_snapshot (
        singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
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

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
