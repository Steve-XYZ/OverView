/**
 * Configuration: which repositories to look at, who "I" am, and what counts as noise.
 *
 * Plain JSON on disk, validated on load. No schema library — the surface is small
 * enough that hand-written checks give better messages than a generic validator.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

export interface RepoConfig {
  /** Absolute path to a local checkout. */
  readonly path: string;
  /** `owner/name`. Auto-detected from the `origin` remote when omitted. */
  readonly githubRepo?: string;
  /** Branch to treat as shipped history. Auto-detected when omitted. */
  readonly defaultBranch?: string;
}

export interface OverviewConfig {
  readonly identity: {
    readonly githubLogin: string | null;
    readonly gitEmails: readonly string[];
  };
  readonly repositories: readonly RepoConfig[];
  readonly sync: {
    /** How far back to retain and ingest commits, based on author date. */
    readonly sinceDays: number;
    /** Run `git fetch --quiet` before walking history. Off by default: it touches the network. */
    readonly fetchBeforeSync: boolean;
  };
  /** Globs whose line changes are tallied separately instead of counted as authored work. */
  readonly excludePaths: readonly string[];
  /** SQLite file. Relative paths resolve against the config file's directory. */
  readonly database: string;
  readonly server: { readonly port: number; readonly host: string };
}

export const DEFAULT_EXCLUDE_PATHS = [
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/npm-shrinkwrap.json",
  "**/Cargo.lock",
  "**/go.sum",
  "**/poetry.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.snap",
  "**/dist/**",
  "**/build/**",
  "**/vendor/**",
  "**/node_modules/**",
  "**/*.generated.*",
  "**/*_pb2.py",
  "**/*.pb.go",
] as const;

export const CONFIG_FILENAME = "overview.config.json";

export function defaultConfig(): OverviewConfig {
  return {
    identity: { githubLogin: null, gitEmails: [] },
    repositories: [],
    sync: { sinceDays: 180, fetchBeforeSync: false },
    excludePaths: [...DEFAULT_EXCLUDE_PATHS],
    database: ".overview/overview.db",
    server: { port: 4317, host: "127.0.0.1" },
  };
}

export interface LoadedConfig {
  readonly config: OverviewConfig;
  /** Absolute path of the file it came from. */
  readonly configPath: string;
  /** Absolute path of the SQLite file. */
  readonly databasePath: string;
}

/** Search cwd and its ancestors for a config file, then fall back to `~/.overview`. */
export function findConfigPath(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = resolve(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(homedir(), ".overview", CONFIG_FILENAME);
}

export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const configPath = explicitPath === undefined ? findConfigPath() : resolve(explicitPath);
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `No config at ${configPath}. Run \`overview init\` to create one.`,
    );
  }
  const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const config = validateConfig(raw, configPath);
  return { config, configPath, databasePath: resolveFromConfig(configPath, config.database) };
}

export async function saveConfig(configPath: string, config: OverviewConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function resolveFromConfig(configPath: string, target: string): string {
  return isAbsolute(target) ? target : resolve(dirname(configPath), target);
}

export class ConfigError extends Error {}

function validateConfig(raw: unknown, source: string): OverviewConfig {
  if (!isRecord(raw)) throw new ConfigError(`${source}: top level must be an object.`);
  const base = defaultConfig();

  const identityRaw = isRecord(raw["identity"]) ? raw["identity"] : {};
  const githubLogin = optionalString(
    identityRaw["githubLogin"],
    `${source}: identity.githubLogin`,
  )?.toLowerCase() ?? null;
  const gitEmails = [
    ...new Set(
      stringArray(identityRaw["gitEmails"], `${source}: identity.gitEmails`)
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.length > 0),
    ),
  ];

  const repositoriesRaw = raw["repositories"];
  if (repositoriesRaw !== undefined && !Array.isArray(repositoriesRaw)) {
    throw new ConfigError(`${source}: repositories must be an array.`);
  }
  const repositories = (repositoriesRaw ?? []).map((entry, index) =>
    validateRepo(entry, `${source}: repositories[${index}]`, source),
  );

  const syncRaw = isRecord(raw["sync"]) ? raw["sync"] : {};
  const sinceDays = positiveInt(
    syncRaw["sinceDays"] ?? base.sync.sinceDays,
    `${source}: sync.sinceDays`,
  );
  const fetchBeforeSync = Boolean(syncRaw["fetchBeforeSync"] ?? base.sync.fetchBeforeSync);

  const serverRaw = isRecord(raw["server"]) ? raw["server"] : {};

  return {
    identity: { githubLogin, gitEmails },
    repositories,
    sync: { sinceDays, fetchBeforeSync },
    excludePaths:
      raw["excludePaths"] === undefined
        ? base.excludePaths
        : stringArray(raw["excludePaths"], `${source}: excludePaths`),
    database: optionalString(raw["database"], `${source}: database`) ?? base.database,
    server: {
      port: positiveInt(serverRaw["port"] ?? base.server.port, `${source}: server.port`),
      host: optionalString(serverRaw["host"], `${source}: server.host`) ?? base.server.host,
    },
  };
}

function validateRepo(entry: unknown, label: string, source: string): RepoConfig {
  if (!isRecord(entry)) throw new ConfigError(`${label} must be an object.`);
  const path = optionalString(entry["path"], `${label}.path`);
  if (path === null || path.length === 0) throw new ConfigError(`${label}.path is required.`);
  const githubRepo = optionalString(entry["githubRepo"], `${label}.githubRepo`);
  if (githubRepo !== null && !/^[^/\s]+\/[^/\s]+$/.test(githubRepo)) {
    throw new ConfigError(`${label}.githubRepo must look like "owner/name", got ${githubRepo}.`);
  }
  const defaultBranch = optionalString(entry["defaultBranch"], `${label}.defaultBranch`);
  return {
    path: resolveFromConfig(source, expandHome(path)),
    ...(githubRepo === null ? {} : { githubRepo }),
    ...(defaultBranch === null ? {} : { defaultBranch }),
  };
}

export function expandHome(target: string): string {
  return target === "~" || target.startsWith("~/")
    ? resolve(homedir(), target.slice(2))
    : target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ConfigError(`${label} must be a string.`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${label} must be an array of strings.`);
  }
  return value as string[];
}

function positiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive integer.`);
  }
  return value;
}
