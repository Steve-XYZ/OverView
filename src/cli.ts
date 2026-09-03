#!/usr/bin/env node
/**
 * Command line entry point.
 *
 *   overview init [--repo <path>]...   create a config, detecting identity from git and gh
 *   overview repo add <path>           add a repository
 *   overview repo list                 show configured repositories
 *   overview sync [--days N] [--only]  ingest git and GitHub into the local database
 *   overview report [--days N]         print the metrics
 *   overview serve [--port N]          serve the dashboard on the loopback interface
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  CONFIG_FILENAME,
  ConfigError,
  defaultConfig,
  expandHome,
  findConfigPath,
  loadConfig,
  saveConfig,
  type OverviewConfig,
  type RepoConfig,
} from "./config/config.ts";
import { openDatabase } from "./store/db.ts";
import { sync } from "./ingest/sync.ts";
import { buildSummary } from "./metrics/summary.ts";
import { createWindow, DEFAULT_WINDOW_DAYS } from "./metrics/window.ts";
import { renderTextReport } from "./report/text.ts";
import { resolveWebRoot, startServer } from "./server/server.ts";
import { assertGitRepository, detectGithubSlug, readConfiguredEmails } from "./ingest/git/gitCli.ts";
import { ghAuthenticated, ghAvailable, viewerLogin } from "./ingest/github/ghCli.ts";

const USAGE = `overview — what did I ship?

  overview init [--repo <path>]...     Create ${CONFIG_FILENAME} and detect your identity
  overview repo add <path> [--github owner/name]
  overview repo list
  overview sync [--days N] [--only <text>] [--no-github]
  overview report [--days N]
  overview serve [--port N] [--host H]

Options
  --config <path>   Use a specific config file
  --days N          Window in days (default ${DEFAULT_WINDOW_DAYS}); for sync, how far back to ingest
`;

await run(process.argv.slice(2));

async function run(argv: string[]): Promise<void> {
  const [command = "", ...rest] = argv;
  try {
    switch (command) {
      case "init":
        await commandInit(rest);
        break;
      case "repo":
        await commandRepo(rest);
        break;
      case "sync":
        await commandSync(rest);
        break;
      case "report":
        await commandReport(rest);
        break;
      case "serve":
        await commandServe(rest);
        break;
      case "":
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        break;
      default:
        process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
        process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

/* --------------------------------------------------------------------- init */

async function commandInit(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      repo: { type: "string", multiple: true },
      force: { type: "boolean" },
    },
    allowPositionals: false,
  });

  const configPath = values.config === undefined ? resolve(process.cwd(), CONFIG_FILENAME) : resolve(values.config);
  if (existsSync(configPath) && values.force !== true) {
    throw new ConfigError(`${configPath} already exists. Pass --force to overwrite it.`);
  }

  const repoPaths = (values.repo ?? []).map((path) => resolve(expandHome(path)));
  const repositories: RepoConfig[] = [];
  for (const path of repoPaths) {
    await assertGitRepository(path);
    const slug = await detectGithubSlug(path);
    repositories.push({ path, ...(slug === null ? {} : { githubRepo: slug }) });
  }

  let githubLogin: string | null = null;
  if ((await ghAvailable()) && (await ghAuthenticated())) {
    try {
      githubLogin = await viewerLogin();
    } catch {
      githubLogin = null;
    }
  }

  const config: OverviewConfig = {
    ...defaultConfig(),
    identity: { githubLogin, gitEmails: await readConfiguredEmails(repoPaths) },
    repositories,
  };

  await saveConfig(configPath, config);
  process.stdout.write(`Wrote ${configPath}\n`);
  process.stdout.write(`  GitHub login: ${githubLogin ?? "(not detected — set identity.githubLogin)"}\n`);
  process.stdout.write(
    `  Git emails:   ${config.identity.gitEmails.join(", ") || "(none — set identity.gitEmails)"}\n`,
  );
  process.stdout.write(`  Repositories: ${repositories.length}\n\n`);
  process.stdout.write(
    "Check identity.gitEmails covers every address you commit under, then run `overview sync`.\n",
  );
}

/* --------------------------------------------------------------------- repo */

async function commandRepo(argv: string[]): Promise<void> {
  const [subcommand = "", ...rest] = argv;
  if (subcommand === "list") {
    const { config, configPath } = await loadConfig(configOption(rest));
    process.stdout.write(`${configPath}\n`);
    if (config.repositories.length === 0) process.stdout.write("  (none configured)\n");
    for (const repo of config.repositories) {
      process.stdout.write(`  ${repo.path}  ${repo.githubRepo ?? "(no GitHub remote)"}\n`);
    }
    return;
  }

  if (subcommand !== "add") throw new ConfigError(`Usage: overview repo add <path>`);

  const { values, positionals } = parseArgs({
    args: rest,
    options: { config: { type: "string" }, github: { type: "string" }, branch: { type: "string" } },
    allowPositionals: true,
  });
  const target = positionals[0];
  if (target === undefined) throw new ConfigError("Usage: overview repo add <path>");

  const path = resolve(expandHome(target));
  await assertGitRepository(path);

  const configPath = values.config === undefined ? findConfigPath() : resolve(values.config);
  const existing = existsSync(configPath)
    ? (await loadConfig(configPath)).config
    : defaultConfig();

  if (existing.repositories.some((repo) => repo.path === path)) {
    process.stdout.write(`${path} is already configured.\n`);
    return;
  }

  const slug = values.github ?? (await detectGithubSlug(path));
  const entry: RepoConfig = {
    path,
    ...(slug === null ? {} : { githubRepo: slug }),
    ...(values.branch === undefined ? {} : { defaultBranch: values.branch }),
  };

  await saveConfig(configPath, { ...existing, repositories: [...existing.repositories, entry] });
  process.stdout.write(`Added ${path} ${slug === null ? "" : `(${slug})`}\n`);
}

/* --------------------------------------------------------------------- sync */

async function commandSync(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      days: { type: "string" },
      only: { type: "string" },
      "no-github": { type: "boolean" },
    },
    allowPositionals: false,
  });

  const { config, configPath, databasePath } = await loadConfig(values.config);
  const db = openDatabase(databasePath);
  try {
    const result = await sync(db, config, {
      ...(values.days === undefined ? {} : { sinceDays: Number.parseInt(values.days, 10) }),
      ...(values.only === undefined ? {} : { only: values.only }),
      ...(values["no-github"] === true ? { skipGithub: true } : {}),
      log: (line) => process.stdout.write(`${line}\n`),
    });

    const totals = result.repositories.reduce(
      (acc, repo) => ({
        commits: acc.commits + repo.commits,
        pullRequests: acc.pullRequests + repo.pullRequests,
        reviews: acc.reviews + repo.reviews,
      }),
      { commits: 0, pullRequests: 0, reviews: 0 },
    );

    process.stdout.write(
      `\nSync #${result.syncRunId} since ${result.sinceIso.slice(0, 10)} as ` +
        `${result.login ?? "(no GitHub login)"}\n` +
        `  ${totals.commits} commits, ${totals.pullRequests} pull requests, ${totals.reviews} reviews\n` +
        `  database ${databasePath}\n`,
    );
    for (const warning of result.warnings) process.stdout.write(`  ⚠ ${warning}\n`);
    for (const repo of result.repositories) {
      if (repo.error !== null) process.stdout.write(`  ✗ ${repo.repositoryKey}: ${repo.error}\n`);
    }
    if (config.identity.githubLogin === null && result.login !== null) {
      process.stdout.write(
        `\nTip: set identity.githubLogin to "${result.login}" in ${configPath} so reports do not have to guess.\n`,
      );
    }
    if (!result.ok) process.exitCode = 1;
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------- report */

async function commandReport(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { config: { type: "string" }, days: { type: "string" }, json: { type: "boolean" } },
    allowPositionals: false,
  });

  const { config, databasePath } = await loadConfig(values.config);
  requireDatabase(databasePath);
  const db = openDatabase(databasePath);
  try {
    const days = values.days === undefined ? DEFAULT_WINDOW_DAYS : Number.parseInt(values.days, 10);
    const summary = buildSummary(db, createWindow(days), config.identity);
    process.stdout.write(
      values.json === true ? `${JSON.stringify(summary, null, 2)}\n` : renderTextReport(summary),
    );
  } finally {
    db.close();
  }
}

/* -------------------------------------------------------------------- serve */

async function commandServe(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { config: { type: "string" }, port: { type: "string" }, host: { type: "string" } },
    allowPositionals: false,
  });

  const { config, databasePath } = await loadConfig(values.config);
  requireDatabase(databasePath);
  const db = openDatabase(databasePath);

  const server = await startServer(db, config, {
    ...(values.port === undefined ? {} : { port: Number.parseInt(values.port, 10) }),
    ...(values.host === undefined ? {} : { host: values.host }),
  });

  process.stdout.write(`Dashboard on ${server.url}\n`);
  if (resolveWebRoot() === null) {
    process.stdout.write("The page assets are not built. Run `npm run build`, then reload.\n");
  }
  process.stdout.write("Ctrl-C to stop.\n");

  const shutdown = (): void => {
    void server.close().then(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/* ------------------------------------------------------------------ helpers */

function configOption(argv: string[]): string | undefined {
  const index = argv.indexOf("--config");
  return index === -1 ? undefined : argv[index + 1];
}

function requireDatabase(databasePath: string): void {
  if (!existsSync(databasePath)) {
    throw new ConfigError(`No database at ${databasePath}. Run \`overview sync\` first.`);
  }
}
