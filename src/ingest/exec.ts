/** Thin wrapper over child processes. The only place ingestion shells out. */

import { spawn } from "node:child_process";

export interface RunOptions {
  readonly cwd?: string;
  /** Written to the child's stdin, then closed. */
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class CommandError extends Error {
  readonly command: string;
  readonly result: RunResult;

  constructor(command: string, result: RunResult) {
    super(`${command} exited ${result.code}: ${result.stderr.trim() || "(no stderr)"}`);
    this.name = "CommandError";
    this.command = command;
    this.result = result;
  }
}

/** Run a command and capture its output. Never uses a shell, so arguments are safe verbatim. */
export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);

    child.on("error", (error) => {
      if (timer !== null) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer !== null) clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

/** Run a command, throwing `CommandError` on a non-zero exit. */
export async function runOrThrow(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) throw new CommandError(`${command} ${args.join(" ")}`, result);
  return result.stdout;
}
