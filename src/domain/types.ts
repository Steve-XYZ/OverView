/**
 * Provider-neutral activity model.
 *
 * Everything the dashboard counts is one of the record types below. Each record
 * carries a `Provenance` block so any number on screen can be walked back to the
 * commit, pull request, or review it came from, and to the sync run that fetched it.
 *
 * Nothing here mentions GitHub or git specifics beyond the `sourceSystem` tag, so a
 * second provider (GitLab, Linear, a GitHub App) adds a collector and a tag value
 * rather than a new model.
 */

export type SourceSystem = "git" | "github" | "linear";

export interface Provenance {
  /** Which collector produced the record. */
  readonly sourceSystem: SourceSystem;
  /** Stable id in the source system: a commit sha, or a GitHub GraphQL node id. */
  readonly sourceId: string;
  /** Human-followable link, when the source has one. */
  readonly sourceUrl: string | null;
  /** When this process wrote the record. */
  readonly recordedAt: string;
  /** The sync run that wrote it. */
  readonly syncRunId: number;
}

/** A repository the user has configured. Local checkout, remote slug, or both. */
export interface RepositoryRecord {
  /** Stable key: `github:owner/name` when a slug is known, else `path:/abs/path`. */
  readonly key: string;
  readonly localPath: string | null;
  readonly provider: "github" | null;
  readonly slug: string | null;
  /** Branch name walked for commits, e.g. `main`. */
  readonly defaultBranch: string | null;
  /** The ref actually walked, e.g. `origin/main`. Recorded so a stale ref is visible. */
  readonly defaultRef: string | null;
  readonly headSha: string | null;
  readonly headCommittedAt: string | null;
}

/** One commit reachable from the repository's default branch. */
export interface CommitRecord {
  readonly repositoryKey: string;
  readonly sha: string;
  readonly authorName: string;
  readonly authorEmail: string;
  /** When the author wrote it. Survives rebase. Used for commit metrics. */
  readonly authoredAt: string;
  readonly committerName: string;
  readonly committerEmail: string;
  /** Committer timestamp from Git. Rewritten by rebase/squash and retained for provenance. */
  readonly committedAt: string;
  readonly subject: string;
  readonly parentCount: number;
  readonly diff: DiffVolume;
  /** The ref this commit was observed on. */
  readonly ref: string;
  readonly provenance: Provenance;
}

/**
 * Change volume for one commit, split so excluded paths are visible rather than
 * silently dropped. `additions`/`deletions` are post-exclusion; the `excluded*`
 * fields hold what the exclusion rules removed.
 */
export interface DiffVolume {
  readonly additions: number;
  readonly deletions: number;
  readonly filesChanged: number;
  readonly excludedAdditions: number;
  readonly excludedDeletions: number;
  readonly excludedFiles: number;
  /** Files git reported as binary (`-`/`-` in numstat); counted as changed, 0 lines. */
  readonly binaryFiles: number;
}

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

export interface PullRequestRecord {
  readonly repositoryKey: string;
  readonly number: number;
  readonly title: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly authorLogin: string | null;
  readonly createdAt: string;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly updatedAt: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly baseRef: string | null;
  /** Source branch the pull request was opened from, e.g. `bos-2422-fix`. Null for old rows. */
  readonly headRef: string | null;
  readonly mergeCommitSha: string | null;
  readonly provenance: Provenance;
}

export type ReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";

export interface ReviewRecord {
  readonly repositoryKey: string;
  /** `sourceId` of the pull request reviewed. */
  readonly pullRequestSourceId: string;
  readonly pullRequestNumber: number;
  readonly reviewerLogin: string;
  readonly state: ReviewState;
  readonly submittedAt: string;
  readonly provenance: Provenance;
}

/**
 * A Linear issue assigned to the developer.
 *
 * Linear issues are workspace-global, not per repository, so there is no
 * `repositoryKey`. The `identifier` (e.g. `BOS-2422`) is the human key engineers
 * already put in branch names and pull request titles; it is the join key the
 * dashboard uses to answer "what work did this activity belong to".
 */
export interface LinearIssueRecord {
  /** Normalised to upper case (`bos-2422` becomes `BOS-2422`). */
  readonly identifier: string;
  readonly title: string;
  readonly stateName: string;
  /** Linear workflow category: `completed`, `canceled`, `started`, etc. */
  readonly stateType: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when the issue entered a completed state. Null until then. */
  readonly completedAt: string | null;
  readonly teamKey: string | null;
  readonly provenance: Provenance;
}

/**
 * Who "I" am across sources. Git identifies people by commit email; GitHub by login.
 * Neither knows about the other, so the user declares both and every metric filters
 * on this. Getting this wrong is the single largest source of wrong numbers.
 */
export interface Identity {
  readonly githubLogin: string | null;
  readonly gitEmails: readonly string[];
}

export type SyncStatus = "running" | "ok" | "failed";
