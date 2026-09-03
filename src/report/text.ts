/** Terminal rendering of a summary, so the numbers are checkable without a browser. */

import type { ActivitySummary } from "../metrics/summary.ts";
import { localDayKey } from "../domain/time.ts";

export function renderTextReport(summary: ActivitySummary): string {
  const lines: string[] = [];
  const t = summary.totals;

  lines.push(
    `Last ${summary.window.days} days  ${summary.window.startDay} .. ${summary.window.endDay}  (${summary.window.timeZone})`,
  );
  lines.push(
    `Identity: ${summary.identity.githubLogin ?? "(no GitHub login)"}  ` +
      `${summary.identity.gitEmails.join(", ") || "(no git emails)"}`,
  );
  lines.push("");

  lines.push(
    row("Commits authored", t.commitsAuthored) +
      row("PRs opened", t.pullRequestsOpened) +
      row("PRs merged", t.pullRequestsMerged),
  );
  lines.push(
    row("Reviews given", t.reviewsGiven) +
      row("Active days", `${t.activeDays}/${summary.window.days}`) +
      row("Median merge", formatHours(summary.mergeTimeHours.median)),
  );
  lines.push(
    row("Lines added", t.additions) +
      row("Lines removed", t.deletions) +
      row("Files touched", t.filesChanged),
  );
  if (t.excludedAdditions + t.excludedDeletions > 0) {
    lines.push(
      `  (excluded by excludePaths: +${t.excludedAdditions} / -${t.excludedDeletions})`,
    );
  }
  lines.push("");

  if (summary.landedPullRequests.length > 0) {
    lines.push(
      `Landed pull requests (showing ${summary.landedPullRequests.length} of ` +
        `${summary.totals.pullRequestsMerged}; lines include excludePaths)`,
    );
    for (const pr of summary.landedPullRequests) {
      lines.push(
        `  ${formatLocalDay(pr.mergedAt, summary.window.timeZone)}  ${pr.repository}#${pr.number}  ` +
          `${truncate(pr.title, 58)}  +${pr.additions}/-${pr.deletions}  ${formatHours(pr.mergeHours)}`,
      );
    }
    lines.push("");
  }

  if (summary.recentCommits.length > 0) {
    lines.push(`Recent commits (showing ${summary.recentCommits.length} of ${t.commitsAuthored})`);
    for (const commit of summary.recentCommits) {
      lines.push(
        `  ${formatLocalDay(commit.authoredAt, summary.window.timeZone)}  ` +
          `${commit.shortSha}  ${commit.repository}  ` +
          `${truncate(commit.subject, 56)}  +${commit.additions}/-${commit.deletions}`,
      );
    }
    lines.push("");
  }

  if (summary.recentReviews.length > 0) {
    lines.push(`Reviews given (showing ${summary.recentReviews.length} of ${t.reviewsGiven})`);
    for (const review of summary.recentReviews) {
      lines.push(
        `  ${formatLocalDay(review.submittedAt, summary.window.timeZone)}  ` +
          `${review.repository}#${review.pullRequestNumber}  ` +
          `${review.state.toLowerCase().replace("_", " ")}  ${truncate(review.title, 48)}`,
      );
    }
    lines.push("");
  }

  const coverage = summary.linear.coverage;
  const share =
    coverage.linkedShare === null ? "—" : `${Math.round(coverage.linkedShare * 100)}%`;
  if (summary.linear.syncStatus === "synced") {
    lines.push(
      `Linear completed (showing ${summary.linear.completedIssues.length} of ` +
        `${summary.linear.completedIssuesTotal})  ` +
        `PR coverage ${coverage.linkedPullRequests}/${coverage.landedPullRequests} linked (${share})`,
    );
  } else {
    lines.push(
      `Linear unavailable (${linearStatusLabel(summary.linear.syncStatus)}); ` +
        `${summary.linear.completedIssuesTotal} cached completed issues. ` +
        "PR coverage is unavailable until a successful Linear sync.",
    );
  }
  for (const issue of summary.linear.completedIssues) {
    lines.push(
      `  ${formatLocalDay(issue.completedAt, summary.window.timeZone)}  ` +
        `${issue.identifier}  ${truncate(issue.title, 52)}`,
    );
    for (const pr of issue.pullRequests) {
      lines.push(
        `    PR ${pr.repository}#${pr.number} via ${pr.via.join("+")}  ${truncate(pr.title, 44)}`,
      );
    }
    for (const commit of issue.commits) {
      lines.push(
        `    ${commit.shortSha} via ${commit.via}  ${truncate(commit.subject, 44)}`,
      );
    }
    if (issue.pullRequests.length === 0 && issue.commits.length === 0) {
      lines.push(`    (no linked pull requests or commits in this window)`);
    }
  }
  lines.push("");

  lines.push("Repositories");
  for (const repo of summary.repositories) {
    lines.push(
      `  ${repo.slug ?? repo.key}  path=${repo.localPath ?? "?"}  ref=${repo.defaultRef ?? "?"}  ` +
        `head=${(repo.headSha ?? "").slice(0, 8)}  commits=${repo.commitsAuthored}/${repo.commitsObserved}  ` +
        `authors=${repo.authorEmails.join(",") || "?"}  merged=${repo.pullRequestsMerged}`,
    );
  }

  if (summary.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings");
    for (const warning of summary.warnings) lines.push(`  - ${warning}`);
  }

  return `${lines.join("\n")}\n`;
}

export function formatLocalDay(iso: string, timeZone: string): string {
  const timestamp = Date.parse(iso);
  return Number.isNaN(timestamp) ? iso : localDayKey(timestamp, timeZone);
}

function linearStatusLabel(status: ActivitySummary["linear"]["syncStatus"]): string {
  switch (status) {
    case "missing_key":
      return "LINEAR_API_KEY was missing on the last sync";
    case "skipped":
      return "the last sync skipped Linear";
    case "failed":
      return "the last Linear sync failed";
    case "unknown":
      return "the last sync predates Linear status tracking";
    case "synced":
      return "synced";
  }
}

function row(label: string, value: string | number): string {
  return `  ${label.padEnd(18)}${String(value).padEnd(12)}`;
}

export function formatHours(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text.padEnd(max) : `${text.slice(0, max - 1)}…`;
}
