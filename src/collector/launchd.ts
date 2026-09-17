/**
 * The macOS side of unattended collection.
 *
 * OverView holds no scheduler and no daemon. On macOS the OS already is one:
 * a user LaunchAgent that `launchd` fires on an interval. This module builds
 * the plist and shells out to `launchctl` to load it. The plist invokes the
 * CLI directly — no interactive shell, no rc files — with an absolute node,
 * an absolute CLI entry point, and an explicit `--config`.
 *
 * Plaintext credentials never appear here. The job inherits no secrets from
 * the plist; `collector run` reads `~/.config/overview/env` itself.
 */

import { readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../ingest/exec.ts";

export const COLLECTOR_LABEL = "com.overview.collector";
/** Hourly. Frequent enough to stay current, sparse enough to dodge `gh` rate limits. */
export const COLLECTOR_INTERVAL_SECONDS = 3600;

export interface CollectorPaths {
  readonly homeDir: string;
  /** `~/Library/LaunchAgents/com.overview.collector.plist` */
  readonly plistPath: string;
  /** Where launchd redirects the job's stdout and stderr. */
  readonly logPath: string;
  /** Small JSON record of the last run, read by `status` and `doctor`. */
  readonly statePath: string;
  /** `~/.config/overview` */
  readonly configDir: string;
}

export function collectorPaths(homeDir: string = homedir()): CollectorPaths {
  const configDir = join(homeDir, ".config", "overview");
  return {
    homeDir,
    plistPath: join(homeDir, "Library", "LaunchAgents", `${COLLECTOR_LABEL}.plist`),
    logPath: join(configDir, "collector.log"),
    statePath: join(configDir, "collector-state.json"),
    configDir,
  };
}

export interface PlistOptions {
  /** Absolute node binary, e.g. `process.execPath`. */
  readonly nodePath: string;
  /** Absolute CLI entry point: `dist/cli.js` when built, else `src/cli.ts`. */
  readonly cliPath: string;
  /** Absolute `overview.config.json` the job syncs. */
  readonly configPath: string;
  readonly logPath: string;
  readonly intervalSeconds?: number;
}

/** Render the plist. Pure, so tests can assert on it without touching launchd. */
export function buildPlist(options: PlistOptions): string {
  const interval = options.intervalSeconds ?? COLLECTOR_INTERVAL_SECONDS;
  const pathEntries = [
    join(dirname(options.nodePath), "..", "bin"),
    dirname(options.nodePath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(COLLECTOR_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.nodePath)}</string>
    <string>${escapeXml(options.cliPath)}</string>
    <string>collector</string>
    <string>run</string>
    <string>--config</string>
    <string>${escapeXml(options.configPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(dirname(options.cliPath))}</string>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(pathEntries.join(":"))}</string>
  </dict>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function plistInstalled(paths: CollectorPaths = collectorPaths()): boolean {
  return existsSync(paths.plistPath);
}

/** Whether launchd currently has the job loaded (armed to fire on its interval). */
export async function plistLoaded(label: string = COLLECTOR_LABEL): Promise<boolean> {
  try {
    const result = await run("launchctl", ["list", label], { timeoutMs: 10_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

/** Read back the interval and config path a previously installed plist recorded. */
export async function readPlistConfig(
  plistPath: string,
): Promise<{ intervalSeconds: number | null; configPath: string | null }> {
  let contents: string;
  try {
    contents = await readFile(plistPath, "utf8");
  } catch {
    return { intervalSeconds: null, configPath: null };
  }
  const interval = /<key>StartInterval<\/key>\s*<integer>(?<seconds>\d+)<\/integer>/.exec(contents);
  const args = contents.split("<string>").slice(1).map((part) => part.split("</string>")[0] as string);
  const flag = args.indexOf("--config");
  const recorded = flag === -1 ? null : (args[flag + 1] ?? null);
  return {
    intervalSeconds: interval?.groups === undefined ? null : Number(interval.groups["seconds"]),
    // buildPlist escapes these values; decode them back to filesystem paths.
    configPath: recorded === null ? null : unescapeXml(recorded),
  };
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

export async function installPlist(
  plist: string,
  paths: CollectorPaths = collectorPaths(),
): Promise<void> {
  await mkdir(dirname(paths.plistPath), { recursive: true });
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(paths.plistPath, plist, { mode: 0o644 });
  const uid = currentUid();
  const bootout = await run("launchctl", ["bootout", `gui/${uid}/${COLLECTOR_LABEL}`], {
    timeoutMs: 15_000,
  });
  void bootout;
  const bootstrap = await run("launchctl", ["bootstrap", `gui/${uid}`, paths.plistPath], {
    timeoutMs: 15_000,
  });
  if (bootstrap.code !== 0) {
    throw new Error(
      `launchctl bootstrap failed (exit ${bootstrap.code}): ` +
        `${bootstrap.stderr.trim() || bootstrap.stdout.trim() || "no output"}`,
    );
  }
}

export async function uninstallPlist(paths: CollectorPaths = collectorPaths()): Promise<boolean> {
  const existed = existsSync(paths.plistPath);
  // A loaded job survives a manually deleted plist, so always attempt bootout:
  // without it, hourly collection would keep firing after "uninstall".
  const uid = currentUid();
  await run("launchctl", ["bootout", `gui/${uid}/${COLLECTOR_LABEL}`], { timeoutMs: 15_000 });
  if (existed) await rm(paths.plistPath, { force: true });
  return existed;
}

/** Fire the installed job immediately, without waiting for its interval. */
export async function kickstartPlist(label: string = COLLECTOR_LABEL): Promise<void> {
  const result = await run("launchctl", ["kickstart", `gui/${currentUid()}/${label}`], {
    timeoutMs: 15_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `launchctl kickstart failed (exit ${result.code}): ` +
        `${result.stderr.trim() || result.stdout.trim() || "no output"}`,
    );
  }
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 501;
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
