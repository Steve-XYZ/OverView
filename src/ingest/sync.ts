/**
 * Sync orchestration: the seam between collectors and storage.
 *
 * Collectors know their source and produce domain records; this file decides what to
 * run and hands the records to the write layer. Adding a provider means adding a
 * collector and a branch here, not touching metrics, storage or the dashboard.
 */

import type { OverviewConfig, RepoConfig } from "../config/config.ts";
import type { Db } from "../store/db.ts";
import { transaction } from "../store/db.ts";
import {
  finishSyncRun,
  startSyncRun,
  upsertCommits,
  upsertPullRequests,
  upsertRepository,
  upsertReviews,
} from "../store/writes.ts";
import { MS_PER_DAY } from "../domain/time.ts";
import { collectFromGit } from "./git/collect.ts";
import { collectFromGithub } from "./github/collect.ts";
import { ghAuthenticated, ghAvailable, viewerLogin } from "./github/ghCli.ts";

export interface SyncOptions {
  /** Overrides `config.sync.sinceDays` for this run. */
  readonly sinceDays?: number;
  /** Substring match against the configured path or slug; syncs only matching repos. */
  readonly only?: string;
  readonly skipGithub?: boolean;
  readonly log?: (line: string) => void;
}

export interface RepoSyncResult {
  readonly repositoryKey: string;
  readonly commits: number;
  readonly pullRequests: number;
  readonly reviews: number;
  readonly error: string | null;
}

export interface SyncResult {
  readonly syncRunId: number;
  readonly sinceIso: string;
  readonly login: string | null;
  readonly repositories: readonly RepoSyncResult[];
  readonly warnings: readonly string[];
  readonly ok: boolean;
}

export async function sync(
  db: Db,
  config: OverviewConfig,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const log = options.log ?? (() => {});
  const warnings: string[] = [];

  const sinceDays = options.sinceDays ?? config.sync.sinceDays;
  const sinceIso = new Date(Date.now() - sinceDays * MS_PER_DAY).toISOString();
  const sinceDay = sinceIso.slice(0, 10);

  const repos = selectRepos(config.repositories, options.only);
  if (repos.length === 0) {
    warnings.push(
      options.only === undefined
        ? "No repositories configured. Add one with `overview repo add <path>`."
        : `No configured repository matches "${options.only}".`,
    );
  }

  const github = options.skipGithub === true ? null : await resolveGithub(config, warnings);
  const syncRunId = startSyncRun(db, sinceIso, github);
  const results: RepoSyncResult[] = [];

  for (const repo of repos) {
    log(`syncing ${repo.path}`);
    try {
      results.push(await syncRepo(db, repo, config, { syncRunId, sinceIso, sinceDay, github, log, warnings }));
    } catch (error) {
      const reason = message(error);
      log(`  failed: ${reason}`);
      results.push({
        repositoryKey: repo.githubRepo ?? `path:${repo.path}`,
        commits: 0,
        pullRequests: 0,
        reviews: 0,
        error: reason,
      });
    }
  }

  const ok = results.every((result) => result.error === null);
  finishSyncRun(
    db,
    syncRunId,
    ok ? "ok" : "failed",
    JSON.stringify({ repositories: results, warnings }),
  );

  return { syncRunId, sinceIso, login: github, repositories: results, warnings, ok };
}

interface RepoSyncContext {
  readonly syncRunId: number;
  readonly sinceIso: string;
  readonly sinceDay: string;
  readonly github: string | null;
  readonly log: (line: string) => void;
  readonly warnings: string[];
}

async function syncRepo(
  db: Db,
  repo: RepoConfig,
  config: OverviewConfig,
  context: RepoSyncContext,
): Promise<RepoSyncResult> {
  const collected = await collectFromGit(repo, {
    sinceIso: context.sinceIso,
    excludePaths: config.excludePaths,
    fetchBeforeSync: config.sync.fetchBeforeSync,
    syncRunId: context.syncRunId,
  });
  context.warnings.push(...collected.warnings);

  const repositoryId = transaction(db, () => {
    const id = upsertRepository(db, collected.repository);
    upsertCommits(db, id, collected.commits);
    return id;
  });
  context.log(`  ${collected.commits.length} commits from ${collected.repository.defaultRef}`);

  const slug = collected.repository.slug;
  if (slug === null) {
    context.warnings.push(
      `${repo.path}: no GitHub remote detected, so pull requests and reviews are not counted ` +
        `for it. Set "githubRepo" in the config if it does have one.`,
    );
    return {
      repositoryKey: collected.repository.key,
      commits: collected.commits.length,
      pullRequests: 0,
      reviews: 0,
      error: null,
    };
  }
  if (context.github === null) {
    return {
      repositoryKey: collected.repository.key,
      commits: collected.commits.length,
      pullRequests: 0,
      reviews: 0,
      error: null,
    };
  }

  const gh = await collectFromGithub(slug, {
    login: context.github,
    sinceDay: context.sinceDay,
    syncRunId: context.syncRunId,
  });
  context.warnings.push(...gh.warnings);

  transaction(db, () => {
    upsertPullRequests(db, repositoryId, gh.pullRequests);
    upsertReviews(db, repositoryId, gh.reviews);
  });
  context.log(`  ${gh.pullRequests.length} pull requests, ${gh.reviews.length} reviews from ${slug}`);

  return {
    repositoryKey: collected.repository.key,
    commits: collected.commits.length,
    pullRequests: gh.pullRequests.length,
    reviews: gh.reviews.length,
    error: null,
  };
}

function selectRepos(repos: readonly RepoConfig[], only: string | undefined): RepoConfig[] {
  if (only === undefined) return [...repos];
  const needle = only.toLowerCase();
  return repos.filter(
    (repo) =>
      repo.path.toLowerCase().includes(needle) ||
      (repo.githubRepo ?? "").toLowerCase().includes(needle),
  );
}

/** Decide which GitHub login to sync as, or null when GitHub is unavailable. */
async function resolveGithub(config: OverviewConfig, warnings: string[]): Promise<string | null> {
  if (!(await ghAvailable())) {
    warnings.push("`gh` is not on PATH; skipping pull requests and reviews.");
    return null;
  }
  if (!(await ghAuthenticated())) {
    warnings.push("`gh` is not authenticated (`gh auth login`); skipping pull requests and reviews.");
    return null;
  }
  if (config.identity.githubLogin !== null) return config.identity.githubLogin;
  try {
    return await viewerLogin();
  } catch (error) {
    warnings.push(`Could not read the authenticated GitHub login: ${message(error)}`);
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
