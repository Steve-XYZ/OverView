/** Terminal rendering of a summary, so the numbers are checkable without a browser. */

import type { ActivitySummary } from "../metrics/summary.ts";

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
    lines.push(`Landed pull requests (${summary.totals.pullRequestsMerged})`);
    for (const pr of summary.landedPullRequests) {
      lines.push(
        `  ${pr.mergedAt.slice(0, 10)}  ${pr.repository}#${pr.number}  ` +
          `${truncate(pr.title, 58)}  +${pr.additions}/-${pr.deletions}  ${formatHours(pr.mergeHours)}`,
      );
    }
    lines.push("");
  }

  if (summary.recentCommits.length > 0) {
    lines.push(`Recent commits (showing ${summary.recentCommits.length} of ${t.commitsAuthored})`);
    for (const commit of summary.recentCommits) {
      lines.push(
        `  ${commit.authoredAt.slice(0, 10)}  ${commit.shortSha}  ${commit.repository}  ` +
          `${truncate(commit.subject, 56)}  +${commit.additions}/-${commit.deletions}`,
      );
    }
    lines.push("");
  }

  if (summary.recentReviews.length > 0) {
    lines.push(`Reviews given (showing ${summary.recentReviews.length} of ${t.reviewsGiven})`);
    for (const review of summary.recentReviews) {
      lines.push(
        `  ${review.submittedAt.slice(0, 10)}  ${review.repository}#${review.pullRequestNumber}  ` +
          `${review.state.toLowerCase().replace("_", " ")}  ${truncate(review.title, 48)}`,
      );
    }
    lines.push("");
  }

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
