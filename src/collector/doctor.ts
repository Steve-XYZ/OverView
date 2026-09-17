/**
 * Health reporting for unattended collection.
 *
 * `overview doctor` answers one question: will the next scheduled run keep
 * the hosted dashboard current, and if not, what exactly is missing? Every
 * check names its consequence, because the failure mode this exists for is
 * silent incompleteness — a green-looking dashboard that quietly stopped
 * counting Linear, a repository, or a whole identity.
 *
 * It reuses the repository diagnostics sync itself uses (`detectDefaultRef`,
 * shallow detection, the `sync_run` row) rather than building a second
 * monitoring system. It never prints a credential, only whether one is set
 * and where it came from. It touches no network beyond what `gh` and git do
 * locally: no fetch, no Linear call, no publish.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { MS_PER_DAY } from "../domain/time.ts";
import { loadConfig, type OverviewConfig, type RepoConfig } from "../config/config.ts";
import { openDatabase } from "../store/db.ts";
import { readAuthorEmailCounts, readLastSyncRun, type SyncRunRow } from "../store/reads.ts";
import { ghAuthenticated, ghAvailable, viewerLogin } from "../ingest/github/ghCli.ts";
import { run } from "../ingest/exec.ts";
import {
  assertGitRepository,
  detectDefaultRef,
  isShallowRepository,
} from "../ingest/git/gitCli.ts";
import { LINEAR_API_KEY_ENV, linearApiKey } from "../ingest/linear/linearApi.ts";
import { PUBLISH_ENDPOINT_ENV, PUBLISH_TOKEN_ENV } from "../publish/publish.ts";
import { collectorEnvPath, inspectCollectorEnvFile } from "./env.ts";
import {
  COLLECTOR_LABEL,
  collectorPaths,
  logInfo,
  plistInstalled,
  plistLoaded,
  readPlistConfig,
  type CollectorPaths,
} from "./launchd.ts";
import { readCollectorState } from "./run.ts";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

export interface DoctorOptions {
  readonly configPath?: string;
  readonly homeDir?: string;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const homeDir = options.homeDir ?? homedir();
  const paths = collectorPaths(homeDir);
  const checks: DoctorCheck[] = [];

  checks.push(await checkGit());
  checks.push(await checkGh());
  checks.push(await checkCredentialsFile(paths));

  let config: OverviewConfig | null = null;
  let configPath = "(unresolved)";
  let databasePath: string | null = null;
  try {
    const loaded = await loadConfig(options.configPath);
    config = loaded.config;
    configPath = loaded.configPath;
    databasePath = loaded.databasePath;
    checks.push({
      name: "config",
      status: "ok",
      detail: `${configPath} with ${config.repositories.length} repositories.`,
    });
  } catch (error) {
    checks.push({
      name: "config",
      status: "fail",
      detail: message(error),
    });
  }

  checks.push(checkLinearCredential());
  checks.push(checkPublishCredential(config));

  if (config !== null) {
    for (const repo of config.repositories) {
      checks.push(await checkRepository(repo));
    }
    if (databasePath !== null && existsSync(databasePath)) {
      checks.push(checkIdentityCoverage(config, databasePath));
      checks.push(checkLastSync(databasePath));
    } else {
      checks.push({
        name: "local sync",
        status: "warn",
        detail: `No database at ${databasePath ?? "(unknown)"}. Run \`overview sync\` once.`,
      });
      checks.push({
        name: "identity coverage",
        status: "warn",
        detail: "No database to measure against. Sync first.",
      });
    }
  }

  checks.push(await checkLastPublication(paths));
  checks.push(await checkCollector(paths, configPath));
  return checks;
}

/** True when every check passed without even a warning. */
export function doctorOk(checks: readonly DoctorCheck[]): boolean {
  return checks.every((check) => check.status === "ok");
}

export function renderDoctor(checks: readonly DoctorCheck[]): string {
  const mark = { ok: "✓", warn: "⚠", fail: "✗" } as const;
  const lines = checks.map((check) => `${mark[check.status]} ${check.name}: ${check.detail}`);
  const fails = checks.filter((check) => check.status === "fail").length;
  const warns = checks.filter((check) => check.status === "warn").length;
  const summary =
    fails > 0
      ? `${fails} failing, ${warns} warning — the next scheduled run will stay incomplete until the failures are fixed.`
      : warns > 0
        ? `${warns} warning${warns === 1 ? "" : "s"} — collection runs, but part of the dashboard is silently incomplete.`
        : "Everything a scheduled run needs is present.";
  return `${lines.join("\n")}\n\n${summary}\n`;
}

/* ------------------------------------------------------------------ checks */

async function checkGit(): Promise<DoctorCheck> {
  try {
    const result = await run("git", ["--version"], { timeoutMs: 10_000 });
    if (result.code !== 0) {
      return { name: "git", status: "fail", detail: "`git` failed to run. Commits cannot be collected." };
    }
    return { name: "git", status: "ok", detail: result.stdout.trim() };
  } catch {
    return {
      name: "git",
      status: "fail",
      detail: "`git` is not on PATH. Commits cannot be collected.",
    };
  }
}

async function checkGh(): Promise<DoctorCheck> {
  if (!(await ghAvailable())) {
    return {
      name: "github cli",
      status: "warn",
      detail: "`gh` is not on PATH, so pull requests and reviews are skipped.",
    };
  }
  if (!(await ghAuthenticated())) {
    return {
      name: "github cli",
      status: "warn",
      detail: "`gh` is not authenticated (`gh auth login`), so pull requests and reviews are skipped.",
    };
  }
  try {
    return { name: "github cli", status: "ok", detail: `authenticated as ${await viewerLogin()}.` };
  } catch {
    return {
      name: "github cli",
      status: "warn",
      detail: "Authenticated, but the viewer login could not be read. Reports will guess from `gh`.",
    };
  }
}

async function checkCredentialsFile(paths: CollectorPaths): Promise<DoctorCheck> {
  const file = await inspectCollectorEnvFile(collectorEnvPath(paths.homeDir));
  if (!file.exists) {
    return {
      name: "credentials file",
      status: "warn",
      detail:
        `No ${file.path}. Credentials set only in an interactive shell are invisible to ` +
        `scheduled runs; create the file (mode 0600) with LINEAR_API_KEY and OVERVIEW_PUBLISH_TOKEN.`,
    };
  }
  if (!file.permissionsOk) {
    return { name: "credentials file", status: "fail", detail: file.error ?? "Unreadable." };
  }
  const keys = file.keysPresent.length === 0 ? "no recognised keys yet" : file.keysPresent.join(", ");
  return { name: "credentials file", status: "ok", detail: `${file.path} (mode ${file.mode}): ${keys}.` };
}

function checkLinearCredential(): DoctorCheck {
  if (linearApiKey() !== null) {
    return { name: "linear credential", status: "ok", detail: `${LINEAR_API_KEY_ENV} is set.` };
  }
  return {
    name: "linear credential",
    status: "warn",
    detail:
      `${LINEAR_API_KEY_ENV} is unset, so Linear issues are skipped and PR coverage reads 0% linked. ` +
      `Pass --no-linear to silence, or store a key in the credentials file.`,
  };
}

function checkPublishCredential(config: OverviewConfig | null): DoctorCheck {
  const endpoint = process.env[PUBLISH_ENDPOINT_ENV] ?? config?.publish.endpoint ?? null;
  const tokenSet =
    process.env[PUBLISH_TOKEN_ENV] !== undefined && process.env[PUBLISH_TOKEN_ENV] !== "";
  if ((endpoint === null || endpoint.length === 0) && !tokenSet) {
    return {
      name: "publish credential",
      status: "warn",
      detail:
        `No endpoint and no ${PUBLISH_TOKEN_ENV}. Scheduled runs sync locally but the hosted ` +
        `dashboard goes stale.`,
    };
  }
  if (endpoint === null || endpoint.length === 0) {
    return {
      name: "publish credential",
      status: "warn",
      detail: `No publish endpoint. Set publish.endpoint or ${PUBLISH_ENDPOINT_ENV}.`,
    };
  }
  if (!tokenSet) {
    return {
      name: "publish credential",
      status: "warn",
      detail:
        `${PUBLISH_TOKEN_ENV} is unset, so scheduled runs cannot publish to ${endpoint}. ` +
        `Mint a collector token on the hosted dashboard and store it in the credentials file.`,
    };
  }
  return { name: "publish credential", status: "ok", detail: `publishes to ${endpoint}.` };
}

async function checkRepository(repo: RepoConfig): Promise<DoctorCheck> {
  const name = `repo ${repo.githubRepo ?? repo.path}`;
  if (!existsSync(repo.path)) {
    return { name, status: "fail", detail: `${repo.path} does not exist. Nothing from it is counted.` };
  }
  try {
    await assertGitRepository(repo.path);
  } catch {
    return { name, status: "fail", detail: `${repo.path} is not a git repository.` };
  }
  let head;
  try {
    head = await detectDefaultRef(repo.path, repo.defaultBranch);
  } catch {
    return {
      name,
      status: "fail",
      detail: `${repo.path}: no default branch resolves (tried ${repo.defaultBranch ?? "auto"}).`,
    };
  }
  const configured = repo.defaultBranch === undefined ? "auto" : `origin/${repo.defaultBranch}`;
  const shallow = await isShallowRepository(repo.path);
  const notes: string[] = [];
  if (!head.ref.startsWith("origin/")) {
    notes.push(`walks local "${head.ref}" — commits only on the remote default may be missing`);
  } else if (configured !== "auto" && head.ref !== configured) {
    notes.push(`configured ${configured} but resolved ${head.ref}`);
  }
  if (shallow) notes.push("shallow checkout — history before its boundary is unavailable");
  const headLine = `${head.ref}@${head.sha.slice(0, 12)} (${head.committedAt.slice(0, 10)})`;
  if (notes.length > 0) {
    return { name, status: "warn", detail: `${repo.path}: ${headLine}; ${notes.join("; ")}.` };
  }
  return { name, status: "ok", detail: `${repo.path}: ${headLine}.` };
}

function checkIdentityCoverage(config: OverviewConfig, databasePath: string): DoctorCheck {
  const db = openDatabase(databasePath);
  try {
    const sinceMs = Date.now() - config.sync.sinceDays * MS_PER_DAY;
    const counts = readAuthorEmailCounts(db, sinceMs);
    const total = counts.reduce((sum, row) => sum + row.commits, 0);
    if (total === 0) {
      return {
        name: "identity coverage",
        status: "warn",
        detail: "No commits in range to measure. Sync first.",
      };
    }
    const mine = new Set(config.identity.gitEmails);
    const matched = counts
      .filter((row) => mine.has(row.email.toLowerCase()))
      .reduce((sum, row) => sum + row.commits, 0);
    const share = Math.round((matched / total) * 100);
    const missing = counts
      .filter((row) => !mine.has(row.email.toLowerCase()))
      .slice(0, 3)
      .map((row) => `${row.email} (${row.commits})`);
    if (missing.length === 0) {
      return {
        name: "identity coverage",
        status: "ok",
        detail: `${matched}/${total} commits in range match ${mine.size} configured emails.`,
      };
    }
    return {
      name: "identity coverage",
      status: "warn",
      detail:
        `Only ${matched}/${total} commits (${share}%) match the configured emails. ` +
        `Unmatched, most frequent first: ${missing.join(", ")}. ` +
        `Add yours to identity.gitEmails or that work is invisible.`,
    };
  } finally {
    db.close();
  }
}

function checkLastSync(databasePath: string): DoctorCheck {
  const db = openDatabase(databasePath);
  try {
    const runRow: SyncRunRow | null = readLastSyncRun(db);
    if (runRow === null) {
      return { name: "last sync", status: "warn", detail: "No sync recorded. Run `overview sync`." };
    }
    const at = (runRow.finished_at ?? runRow.started_at).slice(0, 16).replace("T", " ");
    const linear = linearStatusNote(runRow.notes);
    if (runRow.status === "running") {
      return {
        name: "last sync",
        status: "warn",
        detail: `#${runRow.id} started at ${at} UTC is still in progress. Recheck when it finishes.`,
      };
    }
    if (runRow.status !== "ok") {
      return {
        name: "last sync",
        status: "fail",
        detail: `#${runRow.id} at ${at} UTC ${runRow.status} (Linear ${linear}). See \`overview collector logs\`.`,
      };
    }
    if (linear === "missing_key") {
      return {
        name: "last sync",
        status: "warn",
        detail: `#${runRow.id} at ${at} UTC ok, but Linear had no key — issue links are incomplete.`,
      };
    }
    return { name: "last sync", status: "ok", detail: `#${runRow.id} at ${at} UTC ok (Linear ${linear}).` };
  } finally {
    db.close();
  }
}

function linearStatusNote(notes: string | null): string {
  if (notes === null) return "unknown";
  try {
    const status = (JSON.parse(notes) as { linear?: { status?: unknown } }).linear?.status;
    return typeof status === "string" ? status : "unknown";
  } catch {
    return "unknown";
  }
}

async function checkLastPublication(paths: CollectorPaths): Promise<DoctorCheck> {
  const state = await readCollectorState(paths.statePath);
  if (state === null) {
    return {
      name: "last publication",
      status: "warn",
      detail: "No collector run recorded yet. Run `overview collector run`.",
    };
  }
  const at = state.lastRunAt.slice(0, 16).replace("T", " ");
  switch (state.publish.status) {
    case "published":
      return {
        name: "last publication",
        status: "ok",
        detail: `published at ${state.publish.publishedAt} (run ${at} UTC).`,
      };
    case "alreadyCurrent":
      return {
        name: "last publication",
        status: "ok",
        detail: `already current as of ${state.publish.publishedAt} (run ${at} UTC).`,
      };
    default:
      return {
        name: "last publication",
        status: "warn",
        detail: `${state.publish.status} at run ${at} UTC: ${state.publish.detail ?? "no detail"}.`,
      };
  }
}

async function checkCollector(paths: CollectorPaths, configPath: string): Promise<DoctorCheck> {
  if (!plistInstalled(paths)) {
    return {
      name: "collector",
      status: "warn",
      detail: `No LaunchAgent installed. Run \`overview collector install\` to automate sync→publish.`,
    };
  }
  const [loaded, recorded, info, state] = await Promise.all([
    plistLoaded(COLLECTOR_LABEL),
    readPlistConfig(paths.plistPath),
    logInfo(paths.logPath),
    readCollectorState(paths.statePath),
  ]);
  const parts: string[] = [];
  parts.push(loaded ? "loaded" : "installed but NOT loaded — runs will not fire until it is bootstrapped");
  if (recorded.intervalSeconds !== null) parts.push(`every ${recorded.intervalSeconds}s`);
  if (recorded.configPath !== null && recorded.configPath !== configPath) {
    parts.push(`watches ${recorded.configPath}`);
  }
  if (state !== null) {
    parts.push(
      `last run ${state.lastRunAt.slice(0, 16).replace("T", " ")} UTC exit ${state.exitCode}`,
    );
  } else if (info.exists) {
    parts.push(`log ${paths.logPath} (${info.bytes} bytes)`);
  } else {
    parts.push("never run");
  }
  const status: DoctorStatus = !loaded ? "warn" : state?.exitCode !== 0 ? "warn" : "ok";
  return { name: "collector", status, detail: `${paths.plistPath}: ${parts.join("; ")}.` };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
