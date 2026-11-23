/** Linux unattended collection: a oneshot service and timer that run `collector run`, with paths only. */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { run, type RunResult } from "../ingest/exec.ts";
import {
  COLLECTOR_INTERVAL_SECONDS,
  collectorPaths,
  type CollectorPaths,
} from "./paths.ts";

/** Service and timer share this stem: `overview-collector.service` / `.timer`. */
export const SYSTEMD_UNIT = "overview-collector";
export const SYSTEMD_SERVICE = `${SYSTEMD_UNIT}.service`;
export const SYSTEMD_TIMER = `${SYSTEMD_UNIT}.timer`;

export interface SystemdPaths extends CollectorPaths {
  /** `~/.config/systemd/user` */
  readonly unitDir: string;
  readonly servicePath: string;
  readonly timerPath: string;
}

export function systemdPaths(homeDir: string = homedir()): SystemdPaths {
  const unitDir = join(homeDir, ".config", "systemd", "user");
  return {
    ...collectorPaths(homeDir),
    unitDir,
    servicePath: join(unitDir, SYSTEMD_SERVICE),
    timerPath: join(unitDir, SYSTEMD_TIMER),
  };
}

export interface SystemdOptions {
  /** Absolute node binary, e.g. `process.execPath`. */
  readonly nodePath: string;
  /** Absolute CLI entry point: `dist/cli.js` when built, else `src/cli.ts`. */
  readonly cliPath: string;
  /** Absolute `overview.config.json` the job syncs. */
  readonly configPath: string;
  readonly logPath: string;
}

/** Render the oneshot service. Pure, so tests can assert without systemd. */
export function buildSystemdService(options: SystemdOptions): string {
  const pathEntries = [
    join(dirname(options.nodePath), "..", "bin"),
    dirname(options.nodePath),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const exec = [
    options.nodePath,
    options.cliPath,
    "collector",
    "run",
    "--config",
    options.configPath,
  ]
    .map(execArgument)
    .join(" ");
  return `[Unit]
Description=OverView scheduled collection
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${unitValue(dirname(options.cliPath))}
Environment=PATH=${unitValue(pathEntries.join(":"))}
ExecStart=${exec}
StandardOutput=append:${unitValue(options.logPath)}
StandardError=append:${unitValue(options.logPath)}
`;
}

/** Render the interval timer. The first run lands a minute after activation. */
export function buildSystemdTimer(intervalSeconds: number = COLLECTOR_INTERVAL_SECONDS): string {
  const interval = Math.max(300, Math.trunc(intervalSeconds));
  return `[Unit]
Description=Run the OverView collector every ${interval}s

[Timer]
OnActiveSec=60s
OnUnitActiveSec=${interval}s
AccuracySec=1min
Unit=${SYSTEMD_SERVICE}

[Install]
WantedBy=timers.target
`;
}

// systemd expands % everywhere and $ in ExecStart; doubling each keeps a path literal.
function unitValue(value: string): string {
  return value.replaceAll("%", "%%");
}

function execArgument(value: string): string {
  const escaped = unitValue(value).replaceAll("$", "$$");
  if (!/[\s"'\\]/.test(escaped)) return escaped;
  return `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function systemdInstalled(paths: SystemdPaths = systemdPaths()): boolean {
  return existsSync(paths.servicePath) && existsSync(paths.timerPath);
}

/** Whether the timer is armed to fire on its interval. */
export async function systemdTimerActive(
  timer: string = SYSTEMD_TIMER,
): Promise<boolean> {
  try {
    const result = await systemctl(["is-active", timer], 10_000);
    return result.stdout.trim() === "active";
  } catch {
    return false;
  }
}

/** Read back the interval and config path the installed units recorded. */
export async function readSystemdConfig(
  paths: SystemdPaths,
): Promise<{ intervalSeconds: number | null; configPath: string | null }> {
  const [service, timer] = await Promise.all([
    readIfPresent(paths.servicePath),
    readIfPresent(paths.timerPath),
  ]);
  const interval = timer === null ? null : /^OnUnitActiveSec=(?<seconds>\d+)s$/m.exec(timer);
  const exec = service === null ? null : /^ExecStart=(?<line>.*)$/m.exec(service);
  const flag = exec?.groups?.["line"]?.match(/\s--config\s+(?<arg>"(?:[^"\\]|\\.)*"|\S+)/);
  const seconds = interval?.groups?.["seconds"];
  const recorded = flag?.groups?.["arg"];
  return {
    intervalSeconds: seconds === undefined ? null : Number(seconds),
    configPath: recorded === undefined ? null : unescapeExecArgument(recorded),
  };
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function unescapeExecArgument(argument: string): string {
  const body =
    argument.length >= 2 && argument.startsWith('"') && argument.endsWith('"')
      ? argument.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
      : argument;
  return body.replaceAll("$$", "$").replaceAll("%%", "%");
}

export async function installSystemd(
  service: string,
  timer: string,
  paths: SystemdPaths = systemdPaths(),
): Promise<void> {
  await mkdir(paths.unitDir, { recursive: true });
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(paths.servicePath, service, { mode: 0o644 });
  await writeFile(paths.timerPath, timer, { mode: 0o644 });
  await systemctl(["daemon-reload"]);
  const enabled = await systemctl(["enable", "--now", SYSTEMD_TIMER]);
  if (enabled.code !== 0) {
    throw new Error(
      `systemctl --user enable --now ${SYSTEMD_TIMER} failed (exit ${enabled.code}): ` +
        `${enabled.stderr.trim() || enabled.stdout.trim() || "no output"}`,
    );
  }
}

export async function uninstallSystemd(paths: SystemdPaths = systemdPaths()): Promise<boolean> {
  const existed = existsSync(paths.servicePath) || existsSync(paths.timerPath);
  // An armed timer outlives a deleted unit file, so stop it before removing.
  await systemctl(["disable", "--now", SYSTEMD_TIMER], 15_000).catch(() => null);
  await rm(paths.servicePath, { force: true });
  await rm(paths.timerPath, { force: true });
  await systemctl(["daemon-reload"]).catch(() => null);
  return existed;
}

/** Fire the installed service immediately, without waiting for the timer. */
export async function kickstartSystemd(): Promise<void> {
  const started = await systemctl(["start", "--no-block", SYSTEMD_SERVICE], 15_000);
  if (started.code !== 0) {
    throw new Error(
      `systemctl --user start ${SYSTEMD_SERVICE} failed (exit ${started.code}): ` +
        `${started.stderr.trim() || started.stdout.trim() || "no output"}`,
    );
  }
}

async function systemctl(args: readonly string[], timeoutMs = 15_000): Promise<RunResult> {
  try {
    return await run("systemctl", ["--user", ...args], { timeoutMs });
  } catch (error) {
    throw new Error(
      `Cannot run \`systemctl --user\`: ${error instanceof Error ? error.message : String(error)}. ` +
        `Scheduled collection needs a running systemd user manager.`,
    );
  }
}
