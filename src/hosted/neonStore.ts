/**
 * The Neon-backed `HostedStore`. Schema is created on first use, as before, so a
 * fresh deployment needs no migration step.
 *
 * Two things live here that are worth knowing before reading the SQL.
 *
 * **Every statement is scoped by `user_id`, and every ledger table's primary key
 * begins with it.** Isolation is a property of the keys, not of the caller.
 *
 * **A publication is authoritative for its coverage range.** Each row records the
 * `publication_id` that last restated it; after upserting, rows inside coverage
 * that carry an older id are deleted. That is the same rule the local collector
 * applies to commits after a rebase, and it is what makes a removed pull request or
 * an unassigned issue disappear from the hosted numbers instead of lingering.
 * Records outside coverage are never touched, so the ledger keeps history the local
 * database no longer holds.
 *
 * Timestamps are stored as epoch milliseconds and ISO text exactly as published.
 * Neither is converted to `timestamptz`: re-rendering a timestamp would change the
 * string the dashboard prints, and the hosted numbers have to match the local ones
 * character for character.
 *
 * `collector_id` carries no foreign key to `overview_collector_token`. Revoking a
 * token must not delete the history that collector published: the id is a label
 * recording who last claimed a record, not an owner the record depends on.
 *
 * The pre-account `overview_published_snapshot` table is deliberately left alone.
 * It is neither read nor dropped here.
 */

import { neon } from "@neondatabase/serverless";
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
} from "../domain/facts.ts";
import type { LedgerPublication, PublicationEnvelope, PublishedSnapshots } from "../publish/publish.ts";
import { mergeCollectors } from "./store.ts";
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
} from "./store.ts";

export const DATABASE_URL_ENV = "DATABASE_URL";

type Sql = ReturnType<typeof neon>;
type Row = Record<string, unknown>;

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

    /**
     * Revoking a credential retires the collector with it.
     *
     * The facts it published stay: they are the account's history, which is why they
     * carry no foreign key to the token. Its publication row does not, because that
     * row is what tells the dashboard when this machine last synced and whether it
     * had a Linear key. A machine you have revoked should not still answer for the
     * account.
     */
    async deleteToken(userId: string, tokenId: string): Promise<boolean> {
      const sql = await ready();
      const rows = await sql`
        WITH removed AS (
          DELETE FROM overview_collector_token
          WHERE id = ${tokenId} AND user_id = ${userId}
          RETURNING id
        ), retired AS (
          DELETE FROM overview_ledger_publication
          WHERE user_id = ${userId} AND collector_id IN (SELECT id FROM removed)
        )
        SELECT id FROM removed
      ` as unknown as readonly { readonly id: string }[];
      return rows.length > 0;
    },

    async findCollectorByTokenHash(hash: string): Promise<CollectorPrincipal | null> {
      const sql = await ready();
      const rows = await sql`
        WITH used AS (
          UPDATE overview_collector_token SET last_used_at = NOW()
          WHERE token_hash = ${hash}
          RETURNING id, user_id
        )
        SELECT used.id AS collector_id, u.id, u.github_user_id, u.github_login
        FROM used JOIN overview_user u ON u.id = used.user_id
      ` as unknown as readonly (UserRow & { readonly collector_id: string })[];
      const row = rows[0];
      if (row === undefined) return null;
      return { user: toUser(row), collectorId: row.collector_id };
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
      ` as unknown as readonly { readonly published_at: string | Date }[];

      if (rows[0] !== undefined) {
        return { publishedAt: toIso(rows[0].published_at), alreadyCurrent: false };
      }
      const current = await sql`
        SELECT published_at FROM overview_user_snapshot WHERE user_id = ${userId}
      ` as unknown as readonly { readonly published_at: string | Date }[];
      const row = current[0];
      if (row === undefined) throw new Error("The published snapshot could not be read after its upsert.");
      return { publishedAt: toIso(row.published_at), alreadyCurrent: true };
    },

    async getSnapshot(userId: string): Promise<StoredSnapshot | null> {
      const sql = await ready();
      const rows = await sql`
        SELECT published_at, snapshot FROM overview_user_snapshot WHERE user_id = ${userId}
      ` as unknown as readonly { readonly published_at: string | Date; readonly snapshot: unknown }[];
      const row = rows[0];
      if (row === undefined) return null;
      const stored = row.snapshot as { readonly snapshots?: PublishedSnapshots };
      if (stored.snapshots === undefined) return null;
      return { publishedAt: toIso(row.published_at), snapshots: stored.snapshots };
    },

    /**
     * Write one collector's publication.
     *
     * The transaction runs even when the content id is unchanged, and that is
     * deliberate. Facts are deduplicated by source identity, so a second collector
     * publishing the same records takes ownership of them; if this collector then
     * short-circuited on a matching content id it would never take them back, and a
     * removal by the other collector would stand uncorrected. Re-running an
     * idempotent transaction is the cheaper of the two mistakes. The publication time
     * is held steady when nothing changed, so repeated publication is still a no-op
     * everywhere it is observable.
     */
    async putLedger(
      userId: string,
      collectorId: string,
      publication: LedgerPublication,
    ): Promise<PublishOutcome> {
      const sql = await ready();
      const current = await sql`
        SELECT publication_id, published_at FROM overview_ledger_publication
        WHERE user_id = ${userId} AND collector_id = ${collectorId}
      ` as unknown as readonly { readonly publication_id: string; readonly published_at: string | Date }[];
      const existing = current[0];
      const alreadyCurrent =
        existing !== undefined && existing.publication_id === publication.publicationId;
      const publishedAt = alreadyCurrent
        ? toIso(existing.published_at)
        : new Date().toISOString();

      await sql.transaction(writeLedger(sql, userId, collectorId, publication, publishedAt));
      return { publishedAt, alreadyCurrent };
    },

    async getLedgerHead(userId: string): Promise<StoredLedgerHead | null> {
      const sql = await ready();
      const rows = await sql`
        SELECT collector_id, published_at, collector
        FROM overview_ledger_publication
        WHERE user_id = ${userId}
        ORDER BY published_at DESC, collector_id
      ` as unknown as readonly Row[];
      if (rows.length === 0) return null;
      const first = rows[0];
      if (first === undefined) return null;
      return {
        publishedAt: toIso(first["published_at"] as string | Date),
        collector: mergeCollectors(rows.map((row) => row["collector"] as CollectorFacts)),
      };
    },

    async readLedgerRecords(userId: string, range: LedgerRange): Promise<LedgerRecords> {
      const sql = await ready();
      const { fromMs, toMs, fromDay, toDay } = range;

      const [
        repositories,
        repositoryDays,
        commits,
        pullRequests,
        reviews,
        linearIssues,
        pullRequestLinks,
        commitLinks,
      ] = await sql.transaction([
        sql`
          SELECT repository_key, slug, default_ref, head_sha, head_committed_at, last_synced_at
          FROM overview_ledger_repository
          WHERE user_id = ${userId}
          ORDER BY repository_key
        `,
        sql`
          SELECT repository_key, day, commits_observed, commits_matched, author_emails
          FROM overview_ledger_repository_day
          WHERE user_id = ${userId} AND day >= ${fromDay} AND day <= ${toDay}
          ORDER BY repository_key, day
        `,
        sql`
          SELECT repository_key, sha, authored_at_ms, committed_at_ms, subject,
                 additions, deletions, files_changed, excluded_additions, excluded_deletions,
                 source_url, recorded_at
          FROM overview_ledger_commit
          WHERE user_id = ${userId} AND authored_at_ms >= ${fromMs} AND authored_at_ms <= ${toMs}
          ORDER BY authored_at_ms DESC, sha
        `,
        // The viewer's own pull requests in range, plus any pull request a review in
        // range points at: a review is shown with its pull request's title, and that
        // pull request is usually somebody else's.
        sql`
          SELECT repository_key, number, title, state, authored_by_viewer,
                 created_at_ms, merged_at_ms, updated_at_ms,
                 additions, deletions, changed_files, merge_commit_sha, source_url, recorded_at
          FROM overview_ledger_pull_request
          WHERE user_id = ${userId}
            AND (
              (authored_by_viewer AND created_at_ms >= ${fromMs} AND created_at_ms <= ${toMs})
              OR (authored_by_viewer AND merged_at_ms >= ${fromMs} AND merged_at_ms <= ${toMs})
              OR (repository_key, number) IN (
                SELECT repository_key, pull_request_number FROM overview_ledger_review
                WHERE user_id = ${userId}
                  AND submitted_at_ms >= ${fromMs} AND submitted_at_ms <= ${toMs}
              )
            )
          ORDER BY repository_key, number
        `,
        sql`
          SELECT source_id, repository_key, pull_request_number, state, submitted_at_ms,
                 source_url, recorded_at
          FROM overview_ledger_review
          WHERE user_id = ${userId} AND submitted_at_ms >= ${fromMs} AND submitted_at_ms <= ${toMs}
          ORDER BY submitted_at_ms DESC, source_id
        `,
        sql`
          SELECT source_id, identifier, title, state_name, state_type,
                 created_at_ms, updated_at_ms, completed_at_ms, team_key, source_url, recorded_at
          FROM overview_ledger_linear_issue
          WHERE user_id = ${userId} AND completed_at_ms >= ${fromMs} AND completed_at_ms <= ${toMs}
          ORDER BY completed_at_ms DESC, identifier
        `,
        sql`
          SELECT repository_key, pull_request_number, issue_identifier, via
          FROM overview_ledger_pull_request_link
          WHERE user_id = ${userId}
            AND (repository_key, pull_request_number) IN (
              SELECT repository_key, number FROM overview_ledger_pull_request
              WHERE user_id = ${userId} AND authored_by_viewer
                AND merged_at_ms >= ${fromMs} AND merged_at_ms <= ${toMs}
            )
          ORDER BY repository_key, pull_request_number, issue_identifier
        `,
        sql`
          SELECT repository_key, sha, issue_identifier, via
          FROM overview_ledger_commit_link
          WHERE user_id = ${userId}
            AND sha IN (
              SELECT sha FROM overview_ledger_commit
              WHERE user_id = ${userId}
                AND authored_at_ms >= ${fromMs} AND authored_at_ms <= ${toMs}
            )
          ORDER BY sha, issue_identifier
        `,
      ]);

      return {
        repositories: (repositories as Row[]).map(toRepositoryFact),
        repositoryDays: (repositoryDays as Row[]).map(toRepositoryDayFact),
        commits: (commits as Row[]).map(toCommitFact),
        pullRequests: (pullRequests as Row[]).map(toPullRequestFact),
        reviews: (reviews as Row[]).map(toReviewFact),
        linearIssues: (linearIssues as Row[]).map(toLinearIssueFact),
        pullRequestLinks: (pullRequestLinks as Row[]).map(toPullRequestLinkFact),
        commitLinks: (commitLinks as Row[]).map(toCommitLinkFact),
      };
    },
  };
}

/* ------------------------------------------------------------------ writes */

/**
 * Every statement one ledger publication runs, in order, for a single transaction.
 *
 * Records arrive as one JSON array per table and are expanded by
 * `jsonb_to_recordset`, so a publication is a fixed number of statements whatever
 * its size. The column aliases are quoted to keep the field names the publication
 * contract already uses, which removes a translation step between the two.
 *
 * Two scopes run through every statement. `user_id` decides what the publication may
 * see at all. `collector_id` decides what it may *remove*: an upsert claims a record
 * for this collector, and every delete is confined to records this collector already
 * held. An account running two collectors over different repositories therefore has
 * each publication correct the half it knows about and leave the other alone.
 */
function writeLedger(
  sql: Sql,
  userId: string,
  collectorId: string,
  publication: LedgerPublication,
  publishedAt: string,
): ReturnType<Sql>[] {
  const id = publication.publicationId;
  const { coverage, facts } = publication;
  const json = (records: readonly unknown[]): string => JSON.stringify(records);

  return [
    sql`
      INSERT INTO overview_ledger_publication (
        user_id, collector_id, schema_version, publication_id, generated_at, published_at,
        coverage_from_ms, coverage_to_ms, coverage_from_day, coverage_to_day, collector
      ) VALUES (
        ${userId}, ${collectorId}, ${publication.schemaVersion}, ${id},
        ${publication.generatedAt}, ${publishedAt},
        ${coverage.fromMs}, ${coverage.toMs}, ${coverage.fromDay}, ${coverage.toDay},
        CAST(${JSON.stringify(facts.collector)} AS jsonb)
      )
      ON CONFLICT (user_id, collector_id) DO UPDATE SET
        schema_version = EXCLUDED.schema_version,
        publication_id = EXCLUDED.publication_id,
        generated_at = EXCLUDED.generated_at,
        published_at = EXCLUDED.published_at,
        coverage_from_ms = EXCLUDED.coverage_from_ms,
        coverage_to_ms = EXCLUDED.coverage_to_ms,
        coverage_from_day = EXCLUDED.coverage_from_day,
        coverage_to_day = EXCLUDED.coverage_to_day,
        collector = EXCLUDED.collector
    `,
    // The snapshots travel with the facts so the previous read path stays available.
    sql`
      INSERT INTO overview_user_snapshot (
        user_id, schema_version, publication_id, published_at, snapshot
      ) VALUES (
        ${userId}, ${publication.schemaVersion}, ${id}, ${publishedAt},
        CAST(${JSON.stringify({
          schemaVersion: publication.schemaVersion,
          publicationId: id,
          snapshots: publication.snapshots,
        })} AS jsonb)
      )
      ON CONFLICT (user_id) DO UPDATE SET
        schema_version = EXCLUDED.schema_version,
        publication_id = EXCLUDED.publication_id,
        published_at = EXCLUDED.published_at,
        snapshot = EXCLUDED.snapshot
    `,

    sql`
      INSERT INTO overview_ledger_repository (
        user_id, repository_key, slug, default_ref, head_sha, head_committed_at,
        last_synced_at, source_system, collector_id, publication_id
      )
      SELECT ${userId}, f."key", f."slug", f."defaultRef", f."headSha", f."headCommittedAt",
             f."lastSyncedAt", 'git', ${collectorId}, ${id}
      FROM jsonb_to_recordset(CAST(${json(facts.repositories)} AS jsonb)) AS f(
        "key" text, "slug" text, "defaultRef" text, "headSha" text,
        "headCommittedAt" text, "lastSyncedAt" text
      )
      ON CONFLICT (user_id, repository_key) DO UPDATE SET
        slug = EXCLUDED.slug,
        default_ref = EXCLUDED.default_ref,
        head_sha = EXCLUDED.head_sha,
        head_committed_at = EXCLUDED.head_committed_at,
        last_synced_at = EXCLUDED.last_synced_at,
        collector_id = EXCLUDED.collector_id,
        publication_id = EXCLUDED.publication_id
    `,
    // A repository dropped from this collector's config takes its records with it,
    // mirroring the cascade the local database applies. The row itself only goes when
    // no other collector still has facts filed under it, so one machine dropping a
    // shared repository cannot leave the other machine's commits without a name.
    sql`
      DELETE FROM overview_ledger_repository r
      WHERE r.user_id = ${userId} AND r.collector_id = ${collectorId}
        AND r.publication_id <> ${id}
        AND NOT EXISTS (
          SELECT 1 FROM overview_ledger_commit c
          WHERE c.user_id = ${userId} AND c.repository_key = r.repository_key
            AND c.collector_id <> ${collectorId}
        )
        AND NOT EXISTS (
          SELECT 1 FROM overview_ledger_pull_request pr
          WHERE pr.user_id = ${userId} AND pr.repository_key = r.repository_key
            AND pr.collector_id <> ${collectorId}
        )
    `,
    ...cascadeDeletes(sql, userId, collectorId, id),

    sql`
      INSERT INTO overview_ledger_repository_day (
        user_id, repository_key, day, commits_observed, commits_matched,
        author_emails, collector_id, publication_id
      )
      SELECT ${userId}, f."repositoryKey", f."day", f."commitsObserved", f."commitsMatched",
             f."authorEmails", ${collectorId}, ${id}
      FROM jsonb_to_recordset(CAST(${json(facts.repositoryDays)} AS jsonb)) AS f(
        "repositoryKey" text, "day" text, "commitsObserved" integer,
        "commitsMatched" integer, "authorEmails" jsonb
      )
      ON CONFLICT (user_id, repository_key, day) DO UPDATE SET
        commits_observed = EXCLUDED.commits_observed,
        commits_matched = EXCLUDED.commits_matched,
        author_emails = EXCLUDED.author_emails,
        collector_id = EXCLUDED.collector_id,
        publication_id = EXCLUDED.publication_id
    `,
    sql`
      DELETE FROM overview_ledger_repository_day
      WHERE user_id = ${userId} AND collector_id = ${collectorId}
        AND publication_id <> ${id}
        AND day >= ${coverage.fromDay} AND day <= ${coverage.toDay}
    `,

    sql`
      INSERT INTO overview_ledger_commit (
        user_id, sha, repository_key, authored_at_ms, committed_at_ms, subject,
        additions, deletions, files_changed, excluded_additions, excluded_deletions,
        source_system, source_url, recorded_at, collector_id, publication_id
      )
      SELECT ${userId}, f."sha", f."repositoryKey", f."authoredAtMs", f."committedAtMs",
             f."subject", f."additions", f."deletions", f."filesChanged",
             f."excludedAdditions", f."excludedDeletions", 'git', f."sourceUrl",
             f."recordedAt", ${collectorId}, ${id}
      FROM jsonb_to_recordset(CAST(${json(facts.commits)} AS jsonb)) AS f(
        "sha" text, "repositoryKey" text, "authoredAtMs" bigint, "committedAtMs" bigint,
        "subject" text, "additions" integer, "deletions" integer, "filesChanged" integer,
        "excludedAdditions" integer, "excludedDeletions" integer, "sourceUrl" text,
        "recordedAt" text
      )
      ON CONFLICT (user_id, sha) DO UPDATE SET
        repository_key = EXCLUDED.repository_key,
        authored_at_ms = EXCLUDED.authored_at_ms,
        committed_at_ms = EXCLUDED.committed_at_ms,
        subject = EXCLUDED.subject,
        additions = EXCLUDED.additions,
        deletions = EXCLUDED.deletions,
        files_changed = EXCLUDED.files_changed,
        excluded_additions = EXCLUDED.excluded_additions,
        excluded_deletions = EXCLUDED.excluded_deletions,
        source_url = EXCLUDED.source_url,
        recorded_at = EXCLUDED.recorded_at,
        collector_id = EXCLUDED.collector_id,
        publication_id = EXCLUDED.publication_id
    `,
    sql`
      DELETE FROM overview_ledger_commit
      WHERE user_id = ${userId} AND collector_id = ${collectorId}
        AND publication_id <> ${id}
        AND authored_at_ms >= ${coverage.fromMs} AND authored_at_ms <= ${coverage.toMs}
    `,

    sql`
      INSERT INTO overview_ledger_pull_request (
        user_id, repository_key, number, title, state, authored_by_viewer,
        created_at_ms, merged_at_ms, updated_at_ms,
        additions, deletions, changed_files, merge_commit_sha,
        source_system, source_url, recorded_at, collector_id, publication_id
      )
      SELECT ${userId}, f."repositoryKey", f."number", f."title", f."state",
             f."authoredByViewer", f."createdAtMs", f."mergedAtMs",
             f."updatedAtMs", f."additions", f."deletions", f."changedFiles",
             f."mergeCommitSha", 'github', f."sourceUrl", f."recordedAt", ${collectorId}, ${id}
      FROM jsonb_to_recordset(CAST(${json(facts.pullRequests)} AS jsonb)) AS f(
        "repositoryKey" text, "number" integer, "title" text, "state" text,
        "authoredByViewer" boolean, "createdAtMs" bigint,
        "mergedAtMs" bigint, "updatedAtMs" bigint,
        "additions" integer, "deletions" integer, "changedFiles" integer,
        "mergeCommitSha" text, "sourceUrl" text, "recordedAt" text
      )
      ON CONFLICT (user_id, repository_key, number) DO UPDATE SET
        title = EXCLUDED.title,
        state = EXCLUDED.state,
        authored_by_viewer = EXCLUDED.authored_by_viewer,
        created_at_ms = EXCLUDED.created_at_ms,
        merged_at_ms = EXCLUDED.merged_at_ms,
        updated_at_ms = EXCLUDED.updated_at_ms,
        additions = EXCLUDED.additions,
        deletions = EXCLUDED.deletions,
        changed_files = EXCLUDED.changed_files,
        merge_commit_sha = EXCLUDED.merge_commit_sha,
        source_url = EXCLUDED.source_url,
        recorded_at = EXCLUDED.recorded_at,
        collector_id = EXCLUDED.collector_id,
        publication_id = EXCLUDED.publication_id
    `,
    // A pull request enters the publication when it was created, merged or updated
    // inside coverage, so the same predicate decides what may be dropped.
    sql`
      DELETE FROM overview_ledger_pull_request
      WHERE user_id = ${userId} AND collector_id = ${collectorId}
        AND publication_id <> ${id}
        AND (
          (created_at_ms >= ${coverage.fromMs} AND created_at_ms <= ${coverage.toMs})
          OR (merged_at_ms >= ${coverage.fromMs} AND merged_at_ms <= ${coverage.toMs})
          OR (updated_at_ms >= ${coverage.fromMs} AND updated_at_ms <= ${coverage.toMs})
        )
    `,

    sql`
      INSERT INTO overview_ledger_review (
        user_id, source_id, repository_key, pull_request_number, state, submitted_at_ms,
        source_system, source_url, recorded_at, collector_id, publication_id
      )
      SELECT ${userId}, f."sourceId", f."repositoryKey", f."pullRequestNumber", f."state",
             f."submittedAtMs", 'github', f."sourceUrl", f."recordedAt", ${collectorId}, ${id}
      FROM jsonb_to_recordset(CAST(${json(facts.reviews)} AS jsonb)) AS f(
        "sourceId" text, "repositoryKey" text, "pullRequestNumber" integer, "state" text,
        "submittedAtMs" bigint, "sourceUrl" text, "recordedAt" text
      )
      ON CONFLICT (user_id, source_id) DO UPDATE SET
        repository_key = EXCLUDED.repository_key,
        pull_request_number = EXCLUDED.pull_request_number,
        state = EXCLUDED.state,
        submitted_at_ms = EXCLUDED.submitted_at_ms,
        source_url = EXCLUDED.source_url,
        recorded_at = EXCLUDED.recorded_at,
        collector_id = EXCLUDED.collector_id,
        publication_id = EXCLUDED.publication_id
    `,
    sql`
      DELETE FROM overview_ledger_review
      WHERE user_id = ${userId} AND collector_id = ${collectorId}
        AND publication_id <> ${id}
        AND submitted_at_ms >= ${coverage.fromMs} AND submitted_at_ms <= ${coverage.toMs}
    `,

    sql`
      INSERT INTO overview_ledger_linear_issue (
        user_id, source_id, identifier, title, state_name, state_type,
        created_at_ms, updated_at_ms, completed_at_ms, team_key,
        source_system, source_url, recorded_at, collector_id, publication_id
      )
      SELECT ${userId}, f."sourceId", f."identifier", f."title", f."stateName", f."stateType",
             f."createdAtMs", f."updatedAtMs", f."completedAtMs", f."teamKey",
             'linear', f."sourceUrl", f."recordedAt", ${collectorId}, ${id}
      FROM jsonb_to_recordset(CAST(${json(facts.linearIssues)} AS jsonb)) AS f(
        "sourceId" text, "identifier" text, "title" text, "stateName" text,
        "stateType" text, "createdAtMs" bigint, "updatedAtMs" bigint,
        "completedAtMs" bigint, "teamKey" text, "sourceUrl" text, "recordedAt" text
      )
      ON CONFLICT (user_id, source_id) DO UPDATE SET
        identifier = EXCLUDED.identifier,
        title = EXCLUDED.title,
        state_name = EXCLUDED.state_name,
        state_type = EXCLUDED.state_type,
        created_at_ms = EXCLUDED.created_at_ms,
        updated_at_ms = EXCLUDED.updated_at_ms,
        completed_at_ms = EXCLUDED.completed_at_ms,
        team_key = EXCLUDED.team_key,
        source_url = EXCLUDED.source_url,
        recorded_at = EXCLUDED.recorded_at,
        collector_id = EXCLUDED.collector_id,
        publication_id = EXCLUDED.publication_id
    `,
    // An issue leaves the publication when it is reopened or unassigned, so a
    // completion inside coverage that is no longer restated is removed.
    sql`
      DELETE FROM overview_ledger_linear_issue
      WHERE user_id = ${userId} AND collector_id = ${collectorId}
        AND publication_id <> ${id}
        AND completed_at_ms >= ${coverage.fromMs} AND completed_at_ms <= ${coverage.toMs}
    `,

    sql`
      INSERT INTO overview_ledger_pull_request_link (
        user_id, repository_key, pull_request_number, issue_identifier, via,
        collector_id, publication_id
      )
      SELECT ${userId}, f."repositoryKey", f."pullRequestNumber", f."issueIdentifier",
             f."via", ${collectorId}, ${id}
      FROM jsonb_to_recordset(CAST(${json(facts.pullRequestLinks)} AS jsonb)) AS f(
        "repositoryKey" text, "pullRequestNumber" integer, "issueIdentifier" text, "via" jsonb
      )
      ON CONFLICT (user_id, repository_key, pull_request_number, issue_identifier)
      DO UPDATE SET via = EXCLUDED.via,
        collector_id = EXCLUDED.collector_id,
        publication_id = EXCLUDED.publication_id
    `,
    // A link has no life of its own. It goes when the record it belongs to was
    // restated without it, which is a retitled pull request losing its issue key,
    // and it goes when that record is no longer there at all.
    sql`
      DELETE FROM overview_ledger_pull_request_link link
      WHERE link.user_id = ${userId} AND link.collector_id = ${collectorId}
        AND link.publication_id <> ${id}
        AND EXISTS (
          SELECT 1 FROM overview_ledger_pull_request pr
          WHERE pr.user_id = ${userId} AND pr.publication_id = ${id}
            AND pr.repository_key = link.repository_key AND pr.number = link.pull_request_number
        )
    `,
    sql`
      DELETE FROM overview_ledger_pull_request_link link
      WHERE link.user_id = ${userId} AND link.collector_id = ${collectorId}
        AND NOT EXISTS (
          SELECT 1 FROM overview_ledger_pull_request pr
          WHERE pr.user_id = ${userId}
            AND pr.repository_key = link.repository_key AND pr.number = link.pull_request_number
        )
    `,

    sql`
      INSERT INTO overview_ledger_commit_link (
        user_id, sha, issue_identifier, repository_key, via, collector_id, publication_id
      )
      SELECT ${userId}, f."sha", f."issueIdentifier", f."repositoryKey", f."via",
             ${collectorId}, ${id}
      FROM jsonb_to_recordset(CAST(${json(facts.commitLinks)} AS jsonb)) AS f(
        "sha" text, "issueIdentifier" text, "repositoryKey" text, "via" text
      )
      ON CONFLICT (user_id, sha, issue_identifier)
      DO UPDATE SET
        repository_key = EXCLUDED.repository_key,
        via = EXCLUDED.via,
        collector_id = EXCLUDED.collector_id,
        publication_id = EXCLUDED.publication_id
    `,
    sql`
      DELETE FROM overview_ledger_commit_link link
      WHERE link.user_id = ${userId} AND link.collector_id = ${collectorId}
        AND link.publication_id <> ${id}
        AND EXISTS (
          SELECT 1 FROM overview_ledger_commit c
          WHERE c.user_id = ${userId} AND c.publication_id = ${id} AND c.sha = link.sha
        )
    `,
    sql`
      DELETE FROM overview_ledger_commit_link link
      WHERE link.user_id = ${userId} AND link.collector_id = ${collectorId}
        AND NOT EXISTS (
          SELECT 1 FROM overview_ledger_commit c
          WHERE c.user_id = ${userId} AND c.sha = link.sha
        )
    `,
  ];
}

/**
 * This collector's facts for repositories it no longer watches, at any age.
 *
 * The surviving set is the repositories *this* publication just restated, which is
 * how a repository leaving the config takes its records with it. Another collector's
 * facts are out of reach even when they sit under the same repository key, so a
 * machine that never had a repository cannot delete the history of one that did.
 */
function cascadeDeletes(
  sql: Sql,
  userId: string,
  collectorId: string,
  publicationId: string,
): ReturnType<Sql>[] {
  return [
    sql`
      DELETE FROM overview_ledger_repository_day
      WHERE user_id = ${userId} AND collector_id = ${collectorId}
        AND repository_key NOT IN (
          SELECT repository_key FROM overview_ledger_repository
          WHERE user_id = ${userId} AND publication_id = ${publicationId}
        )
    `,
    sql`
      DELETE FROM overview_ledger_commit
      WHERE user_id = ${userId} AND collector_id = ${collectorId}
        AND repository_key NOT IN (
          SELECT repository_key FROM overview_ledger_repository
          WHERE user_id = ${userId} AND publication_id = ${publicationId}
        )
    `,
    sql`
      DELETE FROM overview_ledger_pull_request
      WHERE user_id = ${userId} AND collector_id = ${collectorId}
        AND repository_key NOT IN (
          SELECT repository_key FROM overview_ledger_repository
          WHERE user_id = ${userId} AND publication_id = ${publicationId}
        )
    `,
    sql`
      DELETE FROM overview_ledger_review
      WHERE user_id = ${userId} AND collector_id = ${collectorId}
        AND repository_key NOT IN (
          SELECT repository_key FROM overview_ledger_repository
          WHERE user_id = ${userId} AND publication_id = ${publicationId}
        )
    `,
    sql`
      DELETE FROM overview_ledger_pull_request_link
      WHERE user_id = ${userId} AND collector_id = ${collectorId}
        AND repository_key NOT IN (
          SELECT repository_key FROM overview_ledger_repository
          WHERE user_id = ${userId} AND publication_id = ${publicationId}
        )
    `,
    sql`
      DELETE FROM overview_ledger_commit_link
      WHERE user_id = ${userId} AND collector_id = ${collectorId}
        AND repository_key NOT IN (
          SELECT repository_key FROM overview_ledger_repository
          WHERE user_id = ${userId} AND publication_id = ${publicationId}
        )
    `,
  ];
}

/* --------------------------------------------------------------- row shapes */

function toRepositoryFact(row: Row): RepositoryFact {
  return {
    key: String(row["repository_key"]),
    slug: nullableText(row["slug"]),
    localPath: null,
    defaultRef: nullableText(row["default_ref"]),
    headSha: nullableText(row["head_sha"]),
    headCommittedAt: nullableText(row["head_committed_at"]),
    lastSyncedAt: nullableText(row["last_synced_at"]),
  };
}

function toRepositoryDayFact(row: Row): RepositoryDayFact {
  return {
    repositoryKey: String(row["repository_key"]),
    day: String(row["day"]),
    commitsObserved: toNumber(row["commits_observed"]),
    commitsMatched: toNumber(row["commits_matched"]),
    authorEmails: toTextArray(row["author_emails"]),
  };
}

function toCommitFact(row: Row): CommitFact {
  return {
    repositoryKey: String(row["repository_key"]),
    sha: String(row["sha"]),
    authoredAtMs: toNumber(row["authored_at_ms"]),
    committedAtMs: toNumber(row["committed_at_ms"]),
    subject: String(row["subject"]),
    additions: toNumber(row["additions"]),
    deletions: toNumber(row["deletions"]),
    filesChanged: toNumber(row["files_changed"]),
    excludedAdditions: toNumber(row["excluded_additions"]),
    excludedDeletions: toNumber(row["excluded_deletions"]),
    sourceUrl: nullableText(row["source_url"]),
    recordedAt: String(row["recorded_at"]),
  };
}

function toPullRequestFact(row: Row): PullRequestFact {
  const state = String(row["state"]);
  return {
    repositoryKey: String(row["repository_key"]),
    number: toNumber(row["number"]),
    title: String(row["title"]),
    state: state === "MERGED" || state === "CLOSED" ? state : "OPEN",
    authoredByViewer: row["authored_by_viewer"] === true,
    createdAtMs: toNumber(row["created_at_ms"]),
    mergedAtMs: nullableNumber(row["merged_at_ms"]),
    updatedAtMs: toNumber(row["updated_at_ms"]),
    additions: toNumber(row["additions"]),
    deletions: toNumber(row["deletions"]),
    changedFiles: toNumber(row["changed_files"]),
    mergeCommitSha: nullableText(row["merge_commit_sha"]),
    sourceUrl: nullableText(row["source_url"]),
    recordedAt: String(row["recorded_at"]),
  };
}

function toReviewFact(row: Row): ReviewFact {
  return {
    sourceId: String(row["source_id"]),
    repositoryKey: String(row["repository_key"]),
    pullRequestNumber: toNumber(row["pull_request_number"]),
    state: String(row["state"]),
    submittedAtMs: toNumber(row["submitted_at_ms"]),
    sourceUrl: nullableText(row["source_url"]),
    recordedAt: String(row["recorded_at"]),
  };
}

function toLinearIssueFact(row: Row): LinearIssueFact {
  return {
    sourceId: String(row["source_id"]),
    identifier: String(row["identifier"]),
    title: String(row["title"]),
    stateName: String(row["state_name"]),
    stateType: String(row["state_type"]),
    createdAtMs: toNumber(row["created_at_ms"]),
    updatedAtMs: toNumber(row["updated_at_ms"]),
    completedAtMs: nullableNumber(row["completed_at_ms"]),
    teamKey: nullableText(row["team_key"]),
    sourceUrl: nullableText(row["source_url"]),
    recordedAt: String(row["recorded_at"]),
  };
}

function toPullRequestLinkFact(row: Row): PullRequestIssueLinkFact {
  const via = toTextArray(row["via"]).filter(
    (entry): entry is "pr_title" | "pr_branch" => entry === "pr_title" || entry === "pr_branch",
  );
  return {
    repositoryKey: String(row["repository_key"]),
    pullRequestNumber: toNumber(row["pull_request_number"]),
    issueIdentifier: String(row["issue_identifier"]),
    via,
  };
}

function toCommitLinkFact(row: Row): CommitIssueLinkFact {
  return {
    repositoryKey: String(row["repository_key"]),
    sha: String(row["sha"]),
    issueIdentifier: String(row["issue_identifier"]),
    via: "commit_subject",
  };
}

/** `bigint` reaches the driver as a string, so every number is coerced on read. */
function toNumber(value: unknown): number {
  return Number(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/* ------------------------------------------------------------------ schema */

function database(): Sql {
  const connectionString = process.env[DATABASE_URL_ENV];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error(`${DATABASE_URL_ENV} is not configured.`);
  }
  return neon(connectionString);
}

async function ready(): Promise<Sql> {
  await ensureSchema();
  return database();
}

function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const sql = database();
    // One transaction, so a cold start costs one round trip rather than one per table.
    await sql.transaction([
      sql`
        CREATE TABLE IF NOT EXISTS overview_user (
          id text PRIMARY KEY,
          github_user_id bigint NOT NULL UNIQUE,
          github_login text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT NOW()
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS overview_collector_token (
          id text PRIMARY KEY,
          user_id text NOT NULL REFERENCES overview_user(id) ON DELETE CASCADE,
          name text NOT NULL,
          token_prefix text NOT NULL,
          token_hash text NOT NULL UNIQUE,
          created_at timestamptz NOT NULL DEFAULT NOW(),
          last_used_at timestamptz
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS overview_collector_token_user_idx
          ON overview_collector_token (user_id)
      `,
      sql`
        CREATE TABLE IF NOT EXISTS overview_user_snapshot (
          user_id text PRIMARY KEY REFERENCES overview_user(id) ON DELETE CASCADE,
          schema_version integer NOT NULL,
          publication_id text NOT NULL,
          published_at timestamptz NOT NULL,
          snapshot jsonb NOT NULL
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS overview_ledger_publication (
          user_id text NOT NULL REFERENCES overview_user(id) ON DELETE CASCADE,
          collector_id text NOT NULL,
          schema_version integer NOT NULL,
          publication_id text NOT NULL,
          generated_at timestamptz NOT NULL,
          published_at timestamptz NOT NULL,
          coverage_from_ms bigint NOT NULL,
          coverage_to_ms bigint NOT NULL,
          coverage_from_day text NOT NULL,
          coverage_to_day text NOT NULL,
          collector jsonb NOT NULL,
          PRIMARY KEY (user_id, collector_id)
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS overview_ledger_repository (
          user_id text NOT NULL REFERENCES overview_user(id) ON DELETE CASCADE,
          repository_key text NOT NULL,
          slug text,
          default_ref text,
          head_sha text,
          head_committed_at text,
          last_synced_at text,
          source_system text NOT NULL,
          collector_id text NOT NULL,
          publication_id text NOT NULL,
          PRIMARY KEY (user_id, repository_key)
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS overview_ledger_repository_day (
          user_id text NOT NULL REFERENCES overview_user(id) ON DELETE CASCADE,
          repository_key text NOT NULL,
          day text NOT NULL,
          commits_observed integer NOT NULL,
          commits_matched integer NOT NULL,
          author_emails jsonb NOT NULL,
          collector_id text NOT NULL,
          publication_id text NOT NULL,
          PRIMARY KEY (user_id, repository_key, day)
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS overview_ledger_commit (
          user_id text NOT NULL REFERENCES overview_user(id) ON DELETE CASCADE,
          sha text NOT NULL,
          repository_key text NOT NULL,
          authored_at_ms bigint NOT NULL,
          committed_at_ms bigint NOT NULL,
          subject text NOT NULL,
          additions integer NOT NULL,
          deletions integer NOT NULL,
          files_changed integer NOT NULL,
          excluded_additions integer NOT NULL,
          excluded_deletions integer NOT NULL,
          source_system text NOT NULL,
          source_url text,
          recorded_at text NOT NULL,
          collector_id text NOT NULL,
          publication_id text NOT NULL,
          PRIMARY KEY (user_id, sha)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS overview_ledger_commit_window_idx
          ON overview_ledger_commit (user_id, authored_at_ms)
      `,
      sql`
        CREATE TABLE IF NOT EXISTS overview_ledger_pull_request (
          user_id text NOT NULL REFERENCES overview_user(id) ON DELETE CASCADE,
          repository_key text NOT NULL,
          number integer NOT NULL,
          title text NOT NULL,
          state text NOT NULL,
          authored_by_viewer boolean NOT NULL,
          created_at_ms bigint NOT NULL,
          merged_at_ms bigint,
          updated_at_ms bigint NOT NULL,
          additions integer NOT NULL,
          deletions integer NOT NULL,
          changed_files integer NOT NULL,
          merge_commit_sha text,
          source_system text NOT NULL,
          source_url text,
          recorded_at text NOT NULL,
          collector_id text NOT NULL,
          publication_id text NOT NULL,
          PRIMARY KEY (user_id, repository_key, number)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS overview_ledger_pull_request_merged_idx
          ON overview_ledger_pull_request (user_id, merged_at_ms)
      `,
      sql`
        CREATE TABLE IF NOT EXISTS overview_ledger_review (
          user_id text NOT NULL REFERENCES overview_user(id) ON DELETE CASCADE,
          source_id text NOT NULL,
          repository_key text NOT NULL,
          pull_request_number integer NOT NULL,
          state text NOT NULL,
          submitted_at_ms bigint NOT NULL,
          source_system text NOT NULL,
          source_url text,
          recorded_at text NOT NULL,
          collector_id text NOT NULL,
          publication_id text NOT NULL,
          PRIMARY KEY (user_id, source_id)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS overview_ledger_review_window_idx
          ON overview_ledger_review (user_id, submitted_at_ms)
      `,
      sql`
        CREATE TABLE IF NOT EXISTS overview_ledger_linear_issue (
          user_id text NOT NULL REFERENCES overview_user(id) ON DELETE CASCADE,
          source_id text NOT NULL,
          identifier text NOT NULL,
          title text NOT NULL,
          state_name text NOT NULL,
          state_type text NOT NULL,
          created_at_ms bigint NOT NULL,
          updated_at_ms bigint NOT NULL,
          completed_at_ms bigint,
          team_key text,
          source_system text NOT NULL,
          source_url text,
          recorded_at text NOT NULL,
          collector_id text NOT NULL,
          publication_id text NOT NULL,
          PRIMARY KEY (user_id, source_id)
        )
      `,
      sql`
        CREATE INDEX IF NOT EXISTS overview_ledger_linear_issue_completed_idx
          ON overview_ledger_linear_issue (user_id, completed_at_ms)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS overview_ledger_commit_collector_idx
          ON overview_ledger_commit (user_id, collector_id)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS overview_ledger_pull_request_collector_idx
          ON overview_ledger_pull_request (user_id, collector_id)
      `,
      sql`
        CREATE INDEX IF NOT EXISTS overview_ledger_repository_day_collector_idx
          ON overview_ledger_repository_day (user_id, collector_id)
      `,
      sql`
        CREATE TABLE IF NOT EXISTS overview_ledger_pull_request_link (
          user_id text NOT NULL REFERENCES overview_user(id) ON DELETE CASCADE,
          repository_key text NOT NULL,
          pull_request_number integer NOT NULL,
          issue_identifier text NOT NULL,
          via jsonb NOT NULL,
          collector_id text NOT NULL,
          publication_id text NOT NULL,
          PRIMARY KEY (user_id, repository_key, pull_request_number, issue_identifier)
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS overview_ledger_commit_link (
          user_id text NOT NULL REFERENCES overview_user(id) ON DELETE CASCADE,
          sha text NOT NULL,
          issue_identifier text NOT NULL,
          repository_key text NOT NULL,
          via text NOT NULL,
          collector_id text NOT NULL,
          publication_id text NOT NULL,
          PRIMARY KEY (user_id, sha, issue_identifier)
        )
      `,
    ]);
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
