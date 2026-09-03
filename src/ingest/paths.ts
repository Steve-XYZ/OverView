/**
 * Path exclusion for change volume.
 *
 * A single lockfile refresh can add five thousand lines. Counting that as authored
 * work makes change volume the least trustworthy number on the dashboard, so
 * matching paths are tallied into the `excluded*` fields instead of dropped — the
 * total is still recoverable, it is just not presented as work.
 */

import { matchesGlob } from "node:path";

export type PathFilter = (path: string) => boolean;

/** Returns a predicate that is true when the path should be excluded. */
export function createExcludeFilter(patterns: readonly string[]): PathFilter {
  if (patterns.length === 0) return () => false;
  return (path: string): boolean => {
    const normalised = path.replaceAll("\\", "/");
    return patterns.some((pattern) => {
      try {
        return matchesGlob(normalised, pattern);
      } catch {
        return false;
      }
    });
  };
}

/**
 * Resolve the path git reports in `--numstat` for a rename to the post-rename path.
 *
 * git writes renames as `old.ts => new.ts` or, with a shared prefix and suffix, as
 * `src/{old => new}/file.ts`. Exclusion should judge where the file ended up.
 */
export function resolveNumstatPath(raw: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (braced !== null) {
    const [, prefix = "", , to = "", suffix = ""] = braced;
    return `${prefix}${to}${suffix}`.replaceAll("//", "/");
  }
  const arrow = raw.split(" => ");
  const last = arrow.at(-1);
  return last === undefined ? raw : last;
}
