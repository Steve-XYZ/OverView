/**
 * Deterministic Linear linking.
 *
 * Engineers already write the issue key (`BOS-2422`) in branch names and pull
 * request titles. Those strings are explicit evidence, so the dashboard joins on
 * them rather than guessing from words in a title. A pull request or commit is
 * only "linked" when the identifier it names matches a Linear issue row already
 * synced into the database — dangling mentions never create phantom issues.
 *
 * Pure functions only: no I/O, no SQL, no network. `metrics/summary.ts` composes
 * these into the per-issue tables; the collectors never call them.
 */

/** How a pull request earned its link to an issue. Retained per link. */
export type PullRequestLinkEvidence = "pr_title" | "pr_branch";

/** How a commit earned its link to an issue. Retained per link. */
export type CommitLinkEvidence = "commit_subject" | "pr_merge_commit";

export interface PullRequestLink {
  readonly identifier: string;
  readonly via: readonly PullRequestLinkEvidence[];
}

export interface CommitLink {
  readonly identifier: string;
  readonly via: CommitLinkEvidence;
}

/**
 * Linear identifiers look like `BOS-2422`: a team key then a number.
 *
 * The team key must be at least two characters starting with a letter so a
 * version string like `v-2` does not match. Matching is case-insensitive
 * because branches are usually lower case (`bos-2422-fix`); callers normalise
 * to upper case before comparing with stored issues. Underscores count as
 * separators too (`BOS-2422_fix`), because `\b` treats `_` as a word character
 * and would otherwise miss the key.
 */
const IDENTIFIER_PATTERN = /(?<![A-Z0-9])([A-Z][A-Z0-9]{1,10}-\d+)(?![0-9])/gi;

/** All distinct identifiers in `text`, upper-cased, in order of first appearance. */
export function extractLinearIdentifiers(text: string | null | undefined): string[] {
  if (text === null || text === undefined || text.length === 0) return [];
  IDENTIFIER_PATTERN.lastIndex = 0;
  const seen = new Set<string>();
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER_PATTERN.exec(text)) !== null) {
    const identifier = (match[1] ?? "").toUpperCase();
    if (identifier.length === 0 || seen.has(identifier)) continue;
    seen.add(identifier);
    out.push(identifier);
  }
  return out;
}

/**
 * Identifiers a pull request names in its title and/or source branch that are
 * also in `known` (the set of synced Linear identifiers, upper-cased).
 */
export function linkPullRequest(
  title: string | null | undefined,
  headRef: string | null | undefined,
  known: ReadonlySet<string>,
): PullRequestLink[] {
  const byIdentifier = new Map<string, Set<PullRequestLinkEvidence>>();
  for (const identifier of extractLinearIdentifiers(title)) {
    if (!known.has(identifier)) continue;
    let via = byIdentifier.get(identifier);
    if (via === undefined) {
      via = new Set();
      byIdentifier.set(identifier, via);
    }
    via.add("pr_title");
  }
  for (const identifier of extractLinearIdentifiers(headRef)) {
    if (!known.has(identifier)) continue;
    let via = byIdentifier.get(identifier);
    if (via === undefined) {
      via = new Set();
      byIdentifier.set(identifier, via);
    }
    via.add("pr_branch");
  }
  return [...byIdentifier.entries()].map(([identifier, via]) => ({
    identifier,
    via: [...via].sort(),
  }));
}

/** Identifiers a commit subject names that are also in `known`. */
export function linkCommit(
  subject: string | null | undefined,
  known: ReadonlySet<string>,
): CommitLink[] {
  const out: CommitLink[] = [];
  for (const identifier of extractLinearIdentifiers(subject)) {
    if (!known.has(identifier)) continue;
    out.push({ identifier, via: "commit_subject" });
  }
  return out;
}
