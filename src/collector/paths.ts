/** Paths both schedulers share, so `run`, `logs`, `status` and `doctor` read one layout. */

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Hourly. Frequent enough to stay current, sparse enough to dodge `gh` rate limits. */
export const COLLECTOR_INTERVAL_SECONDS = 3600;

export interface CollectorPaths {
  readonly homeDir: string;
  /** `~/.config/overview` */
  readonly configDir: string;
  /** Where the scheduler redirects the job's stdout and stderr. */
  readonly logPath: string;
  /** Small JSON record of the last run, read by `status` and `doctor`. */
  readonly statePath: string;
}

export function collectorPaths(homeDir: string = homedir()): CollectorPaths {
  const configDir = join(homeDir, ".config", "overview");
  return {
    homeDir,
    configDir,
    logPath: join(configDir, "collector.log"),
    statePath: join(configDir, "collector-state.json"),
  };
}

/** Resolve the durable CLI entry point for a repo root: built output when present. */
export function resolveCliPath(repoRoot: string): string {
  const built = join(repoRoot, "dist", "cli.js");
  if (existsSync(built)) return built;
  return join(repoRoot, "src", "cli.ts");
}

/** Best-effort mtime/size of the job log, for `status` without reading it all. */
export async function logInfo(
  logPath: string,
): Promise<{ exists: boolean; bytes: number; mtime: string | null }> {
  try {
    const info = await stat(logPath);
    return { exists: true, bytes: info.size, mtime: info.mtime.toISOString() };
  } catch {
    return { exists: false, bytes: 0, mtime: null };
  }
}
