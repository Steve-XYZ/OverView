#!/usr/bin/env node
/**
 * Command line entry point.
 *
 *   overview init [--repo <path>]...   create a config, detecting identity from git and gh
 *   overview repo add <path>           add a repository
 *   overview repo list                 show configured repositories
 *   overview sync [--days N] [--only]  ingest git and GitHub into the local database
 *   overview report [--days N]         print the metrics
 *   overview publish                   upload redacted facts and 7/30/90-day summaries
 *   overview serve [--port N]          serve the dashboard on the loopback interface
 *   overview collector install|run|status|logs|uninstall
 *                                      automate sync -> publish with launchd
 *   overview doctor                    diagnose what would make collection incomplete
 */

import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import {
  buildLedgerPublication,
  buildPublication,
  publishToHost,
  PUBLISH_ENDPOINT_ENV,
  PUBLISH_TOKEN_ENV,
} from "./publish/publish.ts";
import { collectorEnvPath, loadCollectorEnv } from "./collector/env.ts";
import {
  COLLECTOR_INTERVAL_SECONDS,
  COLLECTOR_LABEL,
  buildPlist,
  collectorPaths,
  installPlist,
  kickstartPlist,
  logInfo,
  plistInstalled,
  plistLoaded,
  readPlistConfig,
  resolveCliPath,
  uninstallPlist,
} from "./collector/launchd.ts";
import { collectorRun, readCollectorState } from "./collector/run.ts";
import { doctorOk, renderDoctor, runDoctor } from "./collector/doctor.ts";

const USAGE = `overview — what did I ship?

  overview init [--repo <path>]...     Create ${CONFIG_FILENAME} and detect your identity
  overview repo add <path> [--github owner/name]
  overview repo list
  overview sync [--days N] [--only <text>] [--no-github] [--no-linear]
  overview report [--days N]
  overview publish [--endpoint <https-url>] [--snapshot-only]
  overview serve [--port N] [--host H]
  overview collector install [--interval <seconds>] [--now]
  overview collector run
  overview collector status
  overview collector logs [--lines N]
  overview collector uninstall
  overview doctor

Options
  --config <path>   Use a specific config file
  --days N          Window in days (default ${DEFAULT_WINDOW_DAYS}); for sync, how far back to ingest
  --endpoint <url>  Override publish.endpoint for this publication
  --snapshot-only   Publish the three summaries without the normalized facts
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
      case "publish":
        await commandPublish(rest);
        break;
      case "serve":
        await commandServe(rest);
        break;
      case "collector":
        await commandCollector(rest);
        break;
      case "doctor":
        await commandDoctor(rest);
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

/* ------------------------------------------------------------------ publish */

async function commandPublish(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      endpoint: { type: "string" },
      "snapshot-only": { type: "boolean" },
    },
    allowPositionals: false,
  });

  const { config, databasePath } = await loadConfig(values.config);
  requireDatabase(databasePath);
  await applyCollectorEnv();
  const endpoint = values.endpoint ?? process.env[PUBLISH_ENDPOINT_ENV] ?? config.publish.endpoint;
  if (endpoint === null || endpoint === undefined || endpoint.length === 0) {
    throw new ConfigError(
      `No publish endpoint configured. Set publish.endpoint or ${PUBLISH_ENDPOINT_ENV}.`,
    );
  }
  const token = process.env[PUBLISH_TOKEN_ENV];
  if (token === undefined || token.length === 0) {
    throw new ConfigError(`${PUBLISH_TOKEN_ENV} is required and is never read from the config file.`);
  }

  const db = openDatabase(databasePath);
  try {
    const snapshotOnly = values["snapshot-only"] === true;
    const publication = snapshotOnly
      ? buildPublication(db, config)
      : buildLedgerPublication(db, config);
    const result = await publishToHost(endpoint, token, publication);

    if (result.alreadyCurrent) {
      process.stdout.write(`Hosted dashboard is already current (${result.publishedAt}).\n`);
    } else {
      process.stdout.write(`Published 7, 30 and 90 day summaries at ${result.publishedAt}.\n`);
    }
    if (!snapshotOnly && "facts" in publication) {
      const { facts, coverage } = publication;
      process.stdout.write(
        `  ledger ${coverage.fromDay}..${coverage.toDay}: ` +
          `${facts.commits.length} commits, ${facts.pullRequests.length} pull requests, ` +
          `${facts.reviews.length} reviews, ${facts.linearIssues.length} Linear issues, ` +
          `${facts.pullRequestLinks.length + facts.commitLinks.length} issue links\n`,
      );
    }
  } finally {
    db.close();
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
      "no-linear": { type: "boolean" },
    },
    allowPositionals: false,
  });

  const { config, configPath, databasePath } = await loadConfig(values.config);
  await applyCollectorEnv();
  const db = openDatabase(databasePath);
  try {
    const result = await sync(db, config, {
      ...(values.days === undefined ? {} : { sinceDays: Number.parseInt(values.days, 10) }),
      ...(values.only === undefined ? {} : { only: values.only }),
      ...(values["no-github"] === true ? { skipGithub: true } : {}),
      ...(values["no-linear"] === true ? { skipLinear: true } : {}),
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
        `  ${totals.commits} commits, ${totals.pullRequests} pull requests, ${totals.reviews} reviews, ` +
        `${result.linearIssues} Linear issues\n` +
        `  database ${databasePath}\n`,
    );
    for (const warning of result.warnings) process.stdout.write(`  ⚠ ${warning}\n`);
    for (const repo of result.repositories) {
      if (repo.error !== null) process.stdout.write(`  ✗ ${repo.repositoryKey}: ${repo.error}\n`);
    }
    if (result.linearError !== null) process.stdout.write(`  ✗ Linear: ${result.linearError}\n`);
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
    process.stdout.write("The page assets are not built. Run `pnpm build`, then reload.\n");
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

/* -------------------------------------------------------------- collector */

async function commandCollector(argv: string[]): Promise<void> {
  const [subcommand = "", ...rest] = argv;
  switch (subcommand) {
    case "install":
      await collectorInstall(rest);
      break;
    case "run":
      await collectorRunCommand(rest);
      break;
    case "status":
      await collectorStatus(rest);
      break;
    case "logs":
      await collectorLogs(rest);
      break;
    case "uninstall":
      await collectorUninstall();
      break;
    default:
      throw new ConfigError(
        "Usage: overview collector install|run|status|logs|uninstall",
      );
  }
}

async function collectorInstall(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      interval: { type: "string" },
      now: { type: "boolean" },
    },
    allowPositionals: false,
  });

  const interval = values.interval === undefined
    ? COLLECTOR_INTERVAL_SECONDS
    : Number.parseInt(values.interval, 10);
  if (!Number.isInteger(interval) || interval < 300) {
    throw new ConfigError("--interval must be at least 300 seconds.");
  }

  const { configPath } = await loadConfig(values.config);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cliPath = resolveCliPath(repoRoot);
  if (!existsSync(cliPath)) {
    throw new ConfigError(`No CLI entry point at ${cliPath}. Run \`pnpm build\` first.`);
  }

  const paths = collectorPaths();
  const plist = buildPlist({
    nodePath: process.execPath,
    cliPath,
    configPath,
    logPath: paths.logPath,
    intervalSeconds: interval,
  });
  await installPlist(plist, paths);

  const envPath = collectorEnvPath();
  if (!existsSync(envPath)) {
    await mkdir(dirname(envPath), { recursive: true });
    await writeFile(
      envPath,
      `# OverView collector credentials. Mode 0600: readable only by you.\n` +
        `# The scheduled job reads this file because launchd never sees your shell.\n` +
        `# Values here never override variables already in the environment.\n` +
        `#\n` +
        `# LINEAR_API_KEY=lin_api_...\n` +
        `# OVERVIEW_PUBLISH_TOKEN=ovp_...\n` +
        `# OVERVIEW_PUBLISH_URL=https://your-overview.vercel.app/api/publish\n`,
      { mode: 0o600 },
    );
  }

  process.stdout.write(`Installed ${COLLECTOR_LABEL} (every ${interval}s, run at login).\n`);
  process.stdout.write(`  watches ${configPath}\n`);
  process.stdout.write(`  invokes ${cliPath}\n`);
  process.stdout.write(`  logs to ${paths.logPath}\n`);
  process.stdout.write(`  credentials in ${envPath}\n`);
  process.stdout.write(`Run \`overview doctor\` to confirm the next scheduled run will be complete.\n`);

  if (values.now === true) {
    await kickstartPlist(COLLECTOR_LABEL);
    process.stdout.write("Started the job now; follow it with `overview collector logs`.\n");
  }
}

async function collectorRunCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { config: { type: "string" } },
    allowPositionals: false,
  });
  const { exitCode } = await collectorRun({
    ...(values.config === undefined ? {} : { configPath: values.config }),
    log: (line) => process.stdout.write(`${line}\n`),
  });
  process.exitCode = exitCode;
}

async function collectorStatus(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { config: { type: "string" } },
    allowPositionals: false,
  });
  const paths = collectorPaths();
  const installed = plistInstalled(paths);
  process.stdout.write(`${COLLECTOR_LABEL}: ${installed ? "installed" : "not installed"}\n`);
  if (!installed) {
    process.stdout.write("Run `overview collector install` to automate sync -> publish.\n");
    return;
  }
  const [loaded, recorded, info, state] = await Promise.all([
    plistLoaded(COLLECTOR_LABEL),
    readPlistConfig(paths.plistPath),
    logInfo(paths.logPath),
    readCollectorState(paths.statePath),
  ]);
  process.stdout.write(`  job: ${loaded ? "loaded (armed)" : "NOT loaded — runs will not fire"}\n`);
  if (recorded.intervalSeconds !== null) {
    process.stdout.write(`  interval: every ${recorded.intervalSeconds}s\n`);
  }
  process.stdout.write(`  watches: ${recorded.configPath ?? "(unknown)"}\n`);
  if (values.config !== undefined) process.stdout.write(`  (ignoring --config for status)\n`);
  if (state === null) {
    process.stdout.write("  last run: never\n");
  } else {
    process.stdout.write(
      `  last run: ${state.lastRunAt} exit ${state.exitCode}\n` +
        `  sync: ${state.sync === null ? "did not complete" : `#${state.sync.runId} ${state.sync.ok ? "ok" : "partial"} (Linear ${state.sync.linearStatus})`}\n` +
        `  publish: ${state.publish.status}${state.publish.publishedAt === null ? "" : ` at ${state.publish.publishedAt}`}\n`,
    );
    if (state.publish.detail !== null) process.stdout.write(`    ${state.publish.detail}\n`);
    if (state.error !== null) process.stdout.write(`    error: ${state.error}\n`);
  }
  process.stdout.write(
    info.exists
      ? `  log: ${paths.logPath} (${info.bytes} bytes, updated ${info.mtime})\n`
      : `  log: ${paths.logPath} (no output yet)\n`,
  );
}

async function collectorLogs(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { lines: { type: "string" } },
    allowPositionals: false,
  });
  const count = values.lines === undefined ? 50 : Number.parseInt(values.lines, 10);
  if (!Number.isInteger(count) || count <= 0) {
    throw new ConfigError("--lines must be a positive integer.");
  }
  const { logPath } = collectorPaths();
  if (!existsSync(logPath)) {
    process.stdout.write(`No log at ${logPath} yet. No scheduled run has produced output.\n`);
    return;
  }
  const lines = (await readFile(logPath, "utf8")).split("\n");
  const tail = lines.slice(-count - 1).join("\n");
  process.stdout.write(`${logPath} (last ${count} lines)\n${tail}${tail.endsWith("\n") ? "" : "\n"}`);
}

async function collectorUninstall(): Promise<void> {
  const removed = await uninstallPlist(collectorPaths());
  process.stdout.write(
    removed
      ? `Removed ${COLLECTOR_LABEL}. Local data and logs are untouched.\n`
      : `${COLLECTOR_LABEL} is not installed.\n`,
  );
}

/* ----------------------------------------------------------------- doctor */

async function commandDoctor(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { config: { type: "string" } },
    allowPositionals: false,
  });
  await applyCollectorEnv();
  const checks = await runDoctor({
    ...(values.config === undefined ? {} : { configPath: values.config }),
  });
  process.stdout.write(renderDoctor(checks));
  if (!doctorOk(checks)) process.exitCode = 1;
}

/* ------------------------------------------------------------------ helpers */

/**
 * Import scheduled-run credentials before any command that reads them.
 *
 * Prints the refusal warning when the env file exists but is insecure;
 * commands that do not need credentials never call this.
 */
async function applyCollectorEnv(): Promise<void> {
  const result = await loadCollectorEnv();
  if (result.error !== null) process.stderr.write(`${result.error}\n`);
}

function configOption(argv: string[]): string | undefined {
  const index = argv.indexOf("--config");
  return index === -1 ? undefined : argv[index + 1];
}

function requireDatabase(databasePath: string): void {
  if (!existsSync(databasePath)) {
    throw new ConfigError(`No database at ${databasePath}. Run \`overview sync\` first.`);
  }
}
