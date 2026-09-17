/**
 * Local credential loading for unattended collection.
 *
 * Interactive shells export `LINEAR_API_KEY` and `OVERVIEW_PUBLISH_TOKEN` from
 * rc files a launchd job never reads, so scheduled runs silently synced without
 * Linear and skipped publication. This module reads one file instead:
 * `~/.config/overview/env`, in `KEY=VALUE` form.
 *
 * Rules, all deliberate:
 *
 * - Only the keys OverView itself reads are imported (`LINEAR_API_KEY`,
 *   `OVERVIEW_PUBLISH_TOKEN`, `OVERVIEW_PUBLISH_URL`). Anything else in the
 *   file is ignored, so a stray export cannot leak into a child process.
 * - A variable already present in the environment wins. An explicit export is
 *   always more intentional than a file on disk.
 * - The file must be readable only by its owner (no group/other permission
 *   bits). When it is not, nothing is loaded and the caller is told to run
 *   `chmod 600` on it. Failing closed beats syncing with half a credential.
 * - Values are never logged. Callers report key names, never contents.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { LINEAR_API_KEY_ENV } from "../ingest/linear/linearApi.ts";
import { PUBLISH_ENDPOINT_ENV, PUBLISH_TOKEN_ENV } from "../publish/publish.ts";

/** Every key this file is allowed to provide. Nothing else is imported. */
export const COLLECTOR_ENV_KEYS = [
  LINEAR_API_KEY_ENV,
  PUBLISH_TOKEN_ENV,
  PUBLISH_ENDPOINT_ENV,
] as const;

export type CollectorEnvKey = (typeof COLLECTOR_ENV_KEYS)[number];

const KEY_SET = new Set<string>(COLLECTOR_ENV_KEYS);

export interface CollectorEnvResult {
  /** Absolute path that was inspected. */
  readonly path: string;
  /** Whether the file existed and passed the permission check. */
  readonly loaded: boolean;
  /** Names of the allowlisted keys found in the file (never values). */
  readonly keysPresent: readonly string[];
  /** Names of the allowlisted keys copied into `process.env`. */
  readonly keysApplied: readonly string[];
  /** Why nothing was loaded; null when `loaded` is true or the file is absent. */
  readonly error: string | null;
}

/** Where credentials live. Overridable in tests; production always uses `~/.config`. */
export function collectorEnvPath(homeDir: string = homedir()): string {
  return join(homeDir, ".config", "overview", "env");
}

export interface CollectorEnvFile {
  readonly path: string;
  readonly exists: boolean;
  /** False when group/other permission bits are set; nothing may be loaded then. */
  readonly permissionsOk: boolean;
  /** Octal mode string, e.g. `600`. Null when the file does not exist. */
  readonly mode: string | null;
  /** Names of the allowlisted keys found in the file (never values). */
  readonly keysPresent: readonly string[];
  /** Why nothing may be loaded; null when the file is absent or usable. */
  readonly error: string | null;
}

/** Inspect the env file without importing anything into `process.env`. */
export async function inspectCollectorEnvFile(
  path: string = collectorEnvPath(),
): Promise<CollectorEnvFile> {
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch {
    return { path, exists: false, permissionsOk: false, mode: null, keysPresent: [], error: null };
  }
  if ((mode & 0o077) !== 0) {
    return {
      path,
      exists: true,
      permissionsOk: false,
      mode: (mode & 0o777).toString(8),
      keysPresent: [],
      error:
        `Refusing to read credentials from ${path}: it is readable beyond its owner ` +
        `(mode ${((mode & 0o777).toString(8))}). Run \`chmod 600 ${path}\` so only you can read it.`,
    };
  }
  const parsed = parseEnvFile(await readFile(path, "utf8"));
  return {
    path,
    exists: true,
    permissionsOk: true,
    mode: (mode & 0o777).toString(8),
    keysPresent: [...parsed.keys()].filter((key) => KEY_SET.has(key)).sort(),
    error: null,
  };
}

/**
 * Import allowlisted credentials from the env file into `process.env`.
 *
 * Missing file is not an error — a machine that only syncs git needs no
 * credentials. A present-but-insecure file is: nothing is loaded.
 */
export async function loadCollectorEnv(
  env: NodeJS.ProcessEnv = process.env,
  path: string = collectorEnvPath(),
): Promise<CollectorEnvResult> {
  const inspected = await inspectCollectorEnvFile(path);
  if (!inspected.exists) {
    return { path, loaded: false, keysPresent: [], keysApplied: [], error: null };
  }
  if (!inspected.permissionsOk) {
    return {
      path,
      loaded: false,
      keysPresent: [],
      keysApplied: [],
      error: inspected.error,
    };
  }
  const parsed = parseEnvFile(await readFile(path, "utf8"));
  const keysApplied: string[] = [];
  for (const [key, value] of parsed) {
    if (!KEY_SET.has(key)) continue;
    if (env[key] !== undefined) continue;
    env[key] = value;
    keysApplied.push(key);
  }
  keysApplied.sort();
  return { path, loaded: true, keysPresent: inspected.keysPresent, keysApplied, error: null };
}

/**
 * Parse `KEY=VALUE` lines. Supports `export KEY=VALUE`, full-line `#`
 * comments, and single/double-quoted values. Anything without a bare `KEY=`
 * shape is ignored. Malformed lines are skipped, not fatal: this file is
 * hand-edited and one bad line must not cost a whole scheduled run.
 */
export function parseEnvFile(contents: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const match = /^(?<key>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/.exec(body);
    if (match?.groups === undefined) continue;
    out.set(match.groups["key"] as string, unquote((match.groups["value"] as string).trim()));
  }
  return out;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0] as string;
    const last = value[value.length - 1] as string;
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = value.slice(1, -1);
      return first === '"' ? inner.replace(/\\(["\\$`])/g, "$1") : inner;
    }
  }
  const comment = value.search(/(^|\s)#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}
