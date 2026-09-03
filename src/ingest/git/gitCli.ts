/** Everything this project needs to ask a local git checkout. */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { run, runOrThrow } from "../exec.ts";

export interface RepoHead {
  readonly ref: string;
  readonly branch: string;
  readonly sha: string;
  readonly committedAt: string;
}

export class GitError extends Error {}

export async function assertGitRepository(path: string): Promise<void> {
  if (!existsSync(path)) throw new GitError(`No such directory: ${path}`);
  const result = await run("git", ["rev-parse", "--git-dir"], { cwd: path });
  if (result.code !== 0) throw new GitError(`Not a git repository: ${path}`);
}

/** `owner/name` parsed from the `origin` remote, or null when there is no GitHub origin. */
export async function detectGithubSlug(path: string): Promise<string | null> {
  const result = await run("git", ["remote", "get-url", "origin"], { cwd: path });
  if (result.code !== 0) return null;
  return parseGithubSlug(result.stdout.trim());
}

export function parseGithubSlug(remoteUrl: string): string | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/, "");
  const patterns = [
    /^git@github\.com:(?<owner>[^/]+)\/(?<name>[^/]+)$/,
    /^ssh:\/\/git@github\.com\/(?<owner>[^/]+)\/(?<name>[^/]+)$/,
    /^https?:\/\/(?:[^@]+@)?github\.com\/(?<owner>[^/]+)\/(?<name>[^/]+)$/,
    /^github\.com[:/](?<owner>[^/]+)\/(?<name>[^/]+)$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(cleaned);
    if (match?.groups !== undefined) return `${match.groups["owner"]}/${match.groups["name"]}`;
  }
  return null;
}

/**
 * The ref to treat as shipped history.
 *
 * Preference order matters for accuracy: `origin/HEAD` is what the remote calls its
 * default branch, so it beats a local branch that may be behind or renamed. The
 * local `HEAD` is the last resort and is recorded, so a stale answer is visible
 * rather than silent.
 */
export async function detectDefaultRef(path: string, configured?: string): Promise<RepoHead> {
  const candidates: string[] = [];
  if (configured !== undefined) candidates.push(`origin/${configured}`, configured);

  const symbolic = await run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    cwd: path,
  });
  if (symbolic.code === 0) candidates.push(symbolic.stdout.trim());
  candidates.push("origin/main", "origin/master", "main", "master", "HEAD");

  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    const head = await describeRef(path, candidate);
    if (head !== null) return head;
  }
  throw new GitError(`Could not resolve a default branch in ${path}`);
}

async function describeRef(path: string, ref: string): Promise<RepoHead | null> {
  const result = await run("git", ["log", "-1", "--format=%H%x09%cI", ref], { cwd: path });
  if (result.code !== 0) return null;
  const [sha = "", committedAt = ""] = result.stdout.trim().split("\t");
  if (sha.length === 0) return null;
  return { ref, branch: ref.replace(/^origin\//, ""), sha, committedAt };
}

/** `git fetch --quiet origin`. Only called when the config opts in: it touches the network. */
export async function fetchOrigin(path: string): Promise<void> {
  await runOrThrow("git", ["fetch", "--quiet", "--prune", "origin"], {
    cwd: path,
    timeoutMs: 120_000,
  });
}

export async function readGitLog(
  path: string,
  ref: string,
  sinceIso: string,
  format: string,
): Promise<string> {
  return await runOrThrow(
    "git",
    [
      "log",
      ref,
      `--since=${sinceIso}`,
      "--numstat",
      "--no-color",
      "--no-decorate",
      `--format=${format}`,
    ],
    { cwd: path, timeoutMs: 300_000 },
  );
}

/** Emails configured for the user in this checkout, used to seed identity on `init`. */
export async function readConfiguredEmails(paths: readonly string[]): Promise<string[]> {
  const emails = new Set<string>();
  const global = await run("git", ["config", "--global", "--get", "user.email"]);
  if (global.code === 0 && global.stdout.trim().length > 0) {
    emails.add(global.stdout.trim().toLowerCase());
  }
  for (const path of paths) {
    if (!existsSync(resolve(path))) continue;
    const local = await run("git", ["config", "--get", "user.email"], { cwd: path });
    if (local.code === 0 && local.stdout.trim().length > 0) {
      emails.add(local.stdout.trim().toLowerCase());
    }
  }
  return [...emails];
}
