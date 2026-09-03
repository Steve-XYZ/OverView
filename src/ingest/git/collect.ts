/** Turns one local checkout into domain records. Knows git; knows nothing about SQL. */

import type { CommitRecord, Provenance, RepositoryRecord } from "../../domain/types.ts";
import type { RepoConfig } from "../../config/config.ts";
import { LOG_FORMAT, parseGitLog } from "./parseLog.ts";
import {
  assertGitRepository,
  detectDefaultRef,
  detectGithubSlug,
  fetchOrigin,
  readGitLog,
} from "./gitCli.ts";

export interface GitCollectionOptions {
  readonly sinceIso: string;
  readonly excludePaths: readonly string[];
  readonly fetchBeforeSync: boolean;
  readonly syncRunId: number;
}

export interface GitCollection {
  readonly repository: RepositoryRecord;
  readonly commits: readonly CommitRecord[];
  readonly warnings: readonly string[];
}

export async function collectFromGit(
  repoConfig: RepoConfig,
  options: GitCollectionOptions,
): Promise<GitCollection> {
  const warnings: string[] = [];
  await assertGitRepository(repoConfig.path);

  if (options.fetchBeforeSync) {
    try {
      await fetchOrigin(repoConfig.path);
    } catch (error) {
      warnings.push(`${repoConfig.path}: fetch failed, using the local copy — ${message(error)}`);
    }
  }

  const slug = repoConfig.githubRepo ?? (await detectGithubSlug(repoConfig.path));
  const head = await detectDefaultRef(
    repoConfig.path,
    repoConfig.defaultBranch === undefined ? undefined : repoConfig.defaultBranch,
  );
  if (!head.ref.startsWith("origin/")) {
    warnings.push(
      `${repoConfig.path}: no remote-tracking default branch, walked local "${head.ref}" — ` +
        `commits landed by others may be missing.`,
    );
  }

  const repository: RepositoryRecord = {
    key: slug === null ? `path:${repoConfig.path}` : `github:${slug}`,
    localPath: repoConfig.path,
    provider: slug === null ? null : "github",
    slug,
    defaultBranch: head.branch,
    defaultRef: head.ref,
    headSha: head.sha,
    headCommittedAt: head.committedAt,
  };

  const stdout = await readGitLog(repoConfig.path, head.ref, options.sinceIso, LOG_FORMAT);
  const recordedAt = new Date().toISOString();

  const commits = parseGitLog(stdout, options.excludePaths).map((parsed): CommitRecord => {
    const provenance: Provenance = {
      sourceSystem: "git",
      sourceId: parsed.sha,
      sourceUrl: slug === null ? null : `https://github.com/${slug}/commit/${parsed.sha}`,
      recordedAt,
      syncRunId: options.syncRunId,
    };
    return {
      repositoryKey: repository.key,
      sha: parsed.sha,
      authorName: parsed.authorName,
      authorEmail: parsed.authorEmail,
      authoredAt: parsed.authoredAt,
      committerName: parsed.committerName,
      committerEmail: parsed.committerEmail,
      committedAt: parsed.committedAt,
      subject: parsed.subject,
      parentCount: parsed.parentCount,
      diff: parsed.diff,
      ref: head.ref,
      provenance,
    };
  });

  return { repository, commits, warnings };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
