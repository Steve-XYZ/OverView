/**
 * One unattended collection pass: `sync` then `publish`.
 *
 * This is what the LaunchAgent invokes hourly. It deliberately holds no
 * scheduling, no retries, and no daemon state — launchd owns when it runs.
 * Its only contract is isolation: a failed GitHub fetch, Linear request,
 * repository sync, or publication is recorded and reported, and never stops
 * the next scheduled run or corrupts the state the next run reads.
 *
 * - `sync` already isolates per repository and per provider; a repo that
 *   fails keeps its previous rows, so publishing afterwards restates the
 *   last good facts for it rather than deleting them.
 * - Publication is attempted whenever the database is open and an endpoint
 *   and token are available, independently of whether the sync fully
 *   succeeded. The publication carries the sync's warnings, so the hosted
 *   dashboard reports a partial sync honestly instead of going stale.
 * - Every run appends to the job log and rewrites the state file, including
 *   on failure. `collector status` and `doctor` read the state file.
 * - Nothing here prints a credential. Sync and publish log counts, refs, and
 *   warnings only.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "../config/config.ts";
import { sync, type LinearSyncStatus } from "../ingest/sync.ts";
import {
  buildLedgerPublication,
  PUBLISH_ENDPOINT_ENV,
  PUBLISH_TOKEN_ENV,
  publishToHost,
} from "../publish/publish.ts";
import { openDatabase } from "../store/db.ts";
import { loadCollectorEnv, collectorEnvPath } from "./env.ts";
import { collectorPaths, type CollectorPaths } from "./launchd.ts";

export type PublishOutcome = "published" | "alreadyCurrent" | "skipped" | "failed";

export interface CollectorState {
  readonly version: 1;
  readonly lastRunAt: string;
  readonly exitCode: number;
  readonly configPath: string;
  readonly sync: {
    readonly runId: number;
    readonly ok: boolean;
    readonly linearStatus: LinearSyncStatus;
  } | null;
  readonly publish: {
    readonly status: PublishOutcome;
    readonly publishedAt: string | null;
    /** Human detail without secrets: counts, `alreadyCurrent`, or a failure reason. */
    readonly detail: string | null;
  };
  readonly error: string | null;
}

export interface CollectorRunOptions {
  readonly configPath?: string;
  readonly log?: (line: string) => void;
  readonly paths?: CollectorPaths;
  /**
   * Env file to load, or null to skip loading. Tests pass null so a real
   * `~/.config/overview/env` can never inject production credentials into a
   * throwaway run — an empty test database must never be published.
   */
  readonly envPath?: string | null;
}

export interface CollectorRunResult {
  readonly exitCode: number;
  readonly state: CollectorState;
}

export async function collectorRun(options: CollectorRunOptions = {}): Promise<CollectorRunResult> {
  const log = options.log ?? (() => {});
  const paths = options.paths ?? collectorPaths();
  let configPath = options.configPath;

  const env = options.envPath === null
    ? { path: "(skipped)", loaded: false, keysPresent: [], keysApplied: [], error: null }
    : await loadCollectorEnv(process.env, options.envPath ?? collectorEnvPath());
  if (env.error !== null) log(`  ⚠ ${env.error}`);

  let syncPart: CollectorState["sync"] = null;
  let publishPart: CollectorState["publish"] = {
    status: "skipped",
    publishedAt: null,
    detail: null,
  };
  let error: string | null = null;
  let syncOk = false;

  try {
    const loaded = await loadConfig(configPath);
    configPath = loaded.configPath;
    const { config, databasePath } = loaded;
    const db = openDatabase(databasePath);
    try {
      try {
        const result = await sync(db, config, { log });
        syncPart = { runId: result.syncRunId, ok: result.ok, linearStatus: result.linearStatus };
        syncOk = result.ok;
        log(
          `sync #${result.syncRunId}: ` +
            (result.ok ? "ok" : "partial") +
            `, Linear ${result.linearStatus}`,
        );
        for (const warning of result.warnings) log(`  ⚠ ${warning}`);
        for (const repo of result.repositories) {
          if (repo.error !== null) log(`  ✗ ${repo.repositoryKey}: ${repo.error}`);
        }
        if (result.linearError !== null) log(`  ✗ Linear: ${result.linearError}`);
      } catch (syncError) {
        error = message(syncError);
        log(`  ✗ sync failed: ${error}`);
      }

      publishPart = await publishStage(db, config, log);
    } finally {
      db.close();
    }
  } catch (fatal) {
    error = message(fatal);
    log(`  ✗ collector run failed: ${error}`);
  }

  const publishOk = publishPart.status === "published" || publishPart.status === "alreadyCurrent";
  const exitCode = syncOk && publishOk ? 0 : 1;
  const state: CollectorState = {
    version: 1,
    lastRunAt: new Date().toISOString(),
    exitCode,
    configPath: configPath ?? "(unresolved)",
    sync: syncPart,
    publish: publishPart,
    error,
  };
  await writeState(paths.statePath, state);
  return { exitCode, state };
}

/**
 * Publish the ledger when credentials allow, independently of the sync
 * outcome above. A skipped publication (no endpoint or token) is a warning,
 * not a crash: the local database is still current and the next run retries.
 */
async function publishStage(
  db: Parameters<typeof buildLedgerPublication>[0],
  config: Parameters<typeof buildLedgerPublication>[1],
  log: (line: string) => void,
): Promise<CollectorState["publish"]> {
  const endpoint = process.env[PUBLISH_ENDPOINT_ENV] ?? config.publish.endpoint;
  if (endpoint === null || endpoint === undefined || endpoint.length === 0) {
    const detail = `No publish endpoint configured. Set publish.endpoint or ${PUBLISH_ENDPOINT_ENV}.`;
    log(`  ⚠ publish skipped: ${detail}`);
    return { status: "skipped", publishedAt: null, detail };
  }
  const token = process.env[PUBLISH_TOKEN_ENV];
  if (token === undefined || token.length === 0) {
    const detail =
      `${PUBLISH_TOKEN_ENV} is not set. Mint a collector token on the hosted dashboard ` +
      `and store it in the collector env file.`;
    log(`  ⚠ publish skipped: ${detail}`);
    return { status: "skipped", publishedAt: null, detail };
  }

  try {
    const publication = buildLedgerPublication(db, config);
    const result = await publishToHost(endpoint, token, publication);
    const { facts, coverage } = publication;
    const detail =
      `ledger ${coverage.fromDay}..${coverage.toDay}: ` +
      `${facts.commits.length} commits, ${facts.pullRequests.length} pull requests, ` +
      `${facts.reviews.length} reviews, ${facts.linearIssues.length} Linear issues`;
    if (result.alreadyCurrent) {
      log(`hosted dashboard is already current (${result.publishedAt}).`);
      return { status: "alreadyCurrent", publishedAt: result.publishedAt, detail };
    }
    log(`published 7, 30 and 90 day summaries at ${result.publishedAt}.`);
    log(`  ${detail}`);
    return { status: "published", publishedAt: result.publishedAt, detail };
  } catch (publishError) {
    const detail = message(publishError);
    log(`  ✗ publish failed: ${detail}`);
    return { status: "failed", publishedAt: null, detail };
  }
}

export async function readCollectorState(statePath: string): Promise<CollectorState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as CollectorState;
    if (parsed.version !== 1 || typeof parsed.lastRunAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeState(statePath: string, state: CollectorState): Promise<void> {
  try {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
  } catch {
    // The state file is diagnostic. Losing it must never fail a collection run.
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
