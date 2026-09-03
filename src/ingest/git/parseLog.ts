/**
 * Parser for the `git log --numstat` output shape this project asks for.
 *
 * Kept free of I/O so the awkward cases — renames, binary files, merge commits with
 * no diff, subjects containing anything at all — can be tested against fixtures.
 */

import { createExcludeFilter, resolveNumstatPath } from "../paths.ts";
import type { DiffVolume } from "../../domain/types.ts";

/** ASCII record separator (0x1e) and unit separator (0x1f): git will not emit them itself. */
export const RECORD_SEPARATOR = String.fromCharCode(0x1e);
export const UNIT_SEPARATOR = String.fromCharCode(0x1f);

/**
 * The `--format` git is given. Fields, in order: sha, author name, author email,
 * author date, committer name, committer email, committer date, parents, subject.
 */
export const LOG_FORMAT = ["%x1e%H", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%P", "%s"].join(
  "%x1f",
);

export interface ParsedCommit {
  readonly sha: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAt: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committedAt: string;
  readonly subject: string;
  readonly parentCount: number;
  readonly diff: DiffVolume;
}

const HEADER_FIELD_COUNT = 9;

export function parseGitLog(stdout: string, excludePatterns: readonly string[]): ParsedCommit[] {
  const isExcluded = createExcludeFilter(excludePatterns);
  const commits: ParsedCommit[] = [];

  for (const chunk of stdout.split(RECORD_SEPARATOR)) {
    if (chunk.trim().length === 0) continue;
    const lines = chunk.split("\n");
    const header = lines[0];
    if (header === undefined) continue;

    const fields = header.split(UNIT_SEPARATOR);
    if (fields.length < HEADER_FIELD_COUNT) continue;
    // A subject containing the unit separator would over-split; rejoin the tail.
    const subject = fields.slice(HEADER_FIELD_COUNT - 1).join(UNIT_SEPARATOR);

    const parents = (fields[7] ?? "").trim();
    commits.push({
      sha: fields[0] ?? "",
      authorName: fields[1] ?? "",
      authorEmail: fields[2] ?? "",
      authoredAt: fields[3] ?? "",
      committerName: fields[4] ?? "",
      committerEmail: fields[5] ?? "",
      committedAt: fields[6] ?? "",
      subject,
      parentCount: parents.length === 0 ? 0 : parents.split(/\s+/).length,
      diff: sumNumstat(lines.slice(1), isExcluded),
    });
  }

  return commits;
}

function sumNumstat(lines: readonly string[], isExcluded: (path: string) => boolean): DiffVolume {
  let additions = 0;
  let deletions = 0;
  let filesChanged = 0;
  let excludedAdditions = 0;
  let excludedDeletions = 0;
  let excludedFiles = 0;
  let binaryFiles = 0;

  for (const line of lines) {
    if (line.length === 0) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addedRaw = "", deletedRaw = ""] = parts;
    const path = resolveNumstatPath(parts.slice(2).join("\t"));

    // git writes `-` for both counts when the file is binary.
    const isBinary = addedRaw === "-" || deletedRaw === "-";
    const added = isBinary ? 0 : Number.parseInt(addedRaw, 10);
    const deleted = isBinary ? 0 : Number.parseInt(deletedRaw, 10);
    if (Number.isNaN(added) || Number.isNaN(deleted)) continue;

    if (isBinary) binaryFiles += 1;

    if (isExcluded(path)) {
      excludedAdditions += added;
      excludedDeletions += deleted;
      excludedFiles += 1;
    } else {
      additions += added;
      deletions += deleted;
      filesChanged += 1;
    }
  }

  return {
    additions,
    deletions,
    filesChanged,
    excludedAdditions,
    excludedDeletions,
    excludedFiles,
    binaryFiles,
  };
}
