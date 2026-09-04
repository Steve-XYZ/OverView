/**
 * The dashboard.
 *
 * Reads `/api/summary` and renders it. The only contract with the rest of the
 * project is the `ActivitySummary` shape, imported as a type and erased at build
 * time — swapping this page for a hosted UI means keeping that JSON, nothing more.
 *
 * Chart decisions worth knowing: three categorical hues (validated slots 1-3), a 2px
 * surface gap between stacked segments, a 4px rounded cap on the top segment only,
 * one tooltip per column listing every series, and a table view — required relief,
 * because light-mode aqua sits below 3:1 against the surface.
 */

import type { ActivitySummary, DailyBucket } from "../metrics/summary.ts";
import { formatHours, formatLocalDay } from "../report/text.ts";

interface Series {
  readonly key: "commitsAuthored" | "pullRequestsMerged" | "reviewsGiven";
  readonly label: string;
  readonly color: string;
}

const SERIES: readonly Series[] = [
  { key: "commitsAuthored", label: "Commits authored", color: "var(--series-1)" },
  { key: "pullRequestsMerged", label: "PRs merged", color: "var(--series-2)" },
  { key: "reviewsGiven", label: "Reviews given", color: "var(--series-3)" },
];

const RANGES = [7, 30, 90] as const;
const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_HEIGHT = 250;
const MARGIN = { top: 14, right: 8, bottom: 26, left: 40 };
const MAX_BAR_WIDTH = 24;
const SEGMENT_GAP = 2;
const CAP_RADIUS = 4;

let currentDays: number = readDaysFromHash() ?? 30;
let currentSummary: ActivitySummary | null = null;
let chartView: "chart" | "table" = "chart";

void main();

async function main(): Promise<void> {
  buildRangeControl();
  wireViewToggle();
  wireThemeToggle();

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (currentSummary !== null) drawChart(currentSummary);
    }, 120);
  });

  await load(currentDays);
}

async function load(days: number): Promise<void> {
  currentDays = days;
  window.location.hash = `days=${days}`;
  const main = byId("main");
  main.setAttribute("aria-busy", "true");
  markSelected("#range-control", String(days));

  try {
    const response = await fetch(`/api/summary?days=${days}`);
    if (!response.ok) throw new Error(`The server answered ${response.status}.`);
    currentSummary = (await response.json()) as ActivitySummary;
    render(currentSummary);
  } catch (error) {
    byId("warnings").textContent = `Could not load the summary: ${describe(error)}`;
  } finally {
    main.setAttribute("aria-busy", "false");
  }
}

function render(summary: ActivitySummary): void {
  const t = summary.totals;

  byId("scope-line").textContent =
    `${summary.window.startDay} to ${summary.window.endDay} · ${summary.window.timeZone} · ` +
    `GitHub: ${summary.identity.githubLogin ?? "not configured"} · Git emails: ` +
    `${summary.identity.gitEmails.join(", ") || (summary.publishedAt === undefined ? "none configured" : "hidden")} · ` +
    `${summary.repositories.length} ${summary.repositories.length === 1 ? "repository" : "repositories"}`;

  byId("sync-line").textContent =
    summary.publishedAt !== undefined
      ? `Last published ${formatRelative(summary.publishedAt)}`
      : summary.sync.lastRunAt === null
        ? "Never synced — run `overview sync`"
        : `Last synced ${formatRelative(summary.sync.lastRunAt)} (${summary.sync.status})`;

  byId("hero-value").textContent = formatCount(t.pullRequestsMerged);
  byId("hero-note").textContent =
    t.pullRequestsMerged === 0
      ? `Nothing merged in the last ${summary.window.days} days.`
      : `Merged in the last ${summary.window.days} days · median ${formatHours(
          summary.mergeTimeHours.median,
        )} from open to merge · ${formatCount(t.pullRequestsOpened)} opened.`;

  renderKpis(summary);
  drawChart(summary);
  renderChartTable(summary);
  renderPullRequests(summary);
  renderLinear(summary);
  renderCommits(summary);
  renderReviews(summary);
  renderRepositories(summary);
  renderDefinitions(summary);

  byId("warnings").textContent = summary.warnings.map((line) => `⚠ ${line}`).join("\n");
}

/* ---------------------------------------------------------------- stat tiles */

function renderKpis(summary: ActivitySummary): void {
  const t = summary.totals;
  const net = t.additions - t.deletions;
  const tiles: { label: string; value: string; note: string }[] = [
    {
      label: "Commits authored",
      value: formatCount(t.commitsAuthored),
      note: "by author date, non-merge, on the default branch",
    },
    {
      label: "Active days",
      value: `${t.activeDays} / ${summary.window.days}`,
      note: "days with a commit, PR or review",
    },
    {
      label: "Reviews given",
      value: formatCount(t.reviewsGiven),
      note: `${formatCount(t.pullRequestsReviewed)} pull requests`,
    },
    {
      label: "Median time to merge",
      value: formatHours(summary.mergeTimeHours.median),
      note: `p75 ${formatHours(summary.mergeTimeHours.p75)} over ${summary.mergeTimeHours.count} merged`,
    },
    {
      label: "Net lines",
      value: `${net >= 0 ? "+" : "\u2212"}${formatCount(Math.abs(net))}`,
      note: `+${t.additions.toLocaleString()} / \u2212${t.deletions.toLocaleString()} across ${formatCount(
        t.filesChanged,
      )} files`,
    },
    {
      label: "Excluded churn",
      value: formatCount(t.excludedAdditions + t.excludedDeletions),
      note: "lines in excludePaths, not counted above",
    },
  ];

  const row = byId("kpi-row");
  row.replaceChildren(
    ...tiles.map((tile) => {
      const el = element("div", "stat-tile");
      el.append(
        text("p", "stat-label", tile.label),
        text("p", "stat-value", tile.value),
        text("p", "stat-note", tile.note),
      );
      return el;
    }),
  );
}

/* -------------------------------------------------------------------- chart */

function drawChart(summary: ActivitySummary): void {
  const holder = byId("chart-holder");
  const daily = summary.daily;

  byId("chart-sub").textContent =
    `Commits, merges and reviews per local calendar day, ${summary.window.startDay} to ` +
    `${summary.window.endDay}.`;
  renderLegend();

  const total = daily.reduce((acc, day) => acc + dayTotal(day), 0);
  if (total === 0) {
    holder.replaceChildren(
      text("p", "chart-empty", `No recorded activity in the last ${summary.window.days} days.`),
    );
    return;
  }

  const width = Math.max(holder.clientWidth || 900, 320);
  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const baselineY = MARGIN.top + innerHeight;

  const peak = Math.max(...daily.map(dayTotal));
  const { max: axisMax, step } = niceScale(peak);
  const scale = innerHeight / axisMax;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${CHART_HEIGHT}`);
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `Daily activity from ${summary.window.startDay} to ${summary.window.endDay}. ` +
      `Peak ${peak} events in a day. The table view lists every value.`,
  );

  // Gridlines and y ticks.
  for (let value = 0; value <= axisMax; value += step) {
    const y = baselineY - value * scale;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(MARGIN.left));
    line.setAttribute("x2", String(MARGIN.left + innerWidth));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("class", value === 0 ? "baseline" : "gridline");
    svg.append(line);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", String(MARGIN.left - 8));
    label.setAttribute("y", String(y + 4));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "axis-text");
    label.textContent = String(value);
    svg.append(label);
  }

  const band = innerWidth / daily.length;
  const barWidth = Math.max(2, Math.min(MAX_BAR_WIDTH, band - 2));

  daily.forEach((day, index) => {
    const bandX = MARGIN.left + index * band;
    const x = bandX + (band - barWidth) / 2;
    const topKey = SERIES.filter((s) => day[s.key] > 0).at(-1)?.key;

    let cursor = baselineY;
    let isBottomDrawn = true;
    for (const series of SERIES) {
      const value = day[series.key];
      if (value === 0) continue;
      const rawHeight = value * scale;
      const shave = isBottomDrawn ? 0 : SEGMENT_GAP;
      const height = Math.max(1.5, rawHeight - shave);
      const y = cursor - rawHeight;

      const mark =
        series.key === topKey
          ? cappedRect(x, y, barWidth, height)
          : plainRect(x, y, barWidth, height);
      mark.setAttribute("fill", series.color);
      svg.append(mark);

      cursor -= rawHeight;
      isBottomDrawn = false;
    }

    // The hit target is the whole column band, not the painted pixels.
    const hit = document.createElementNS(SVG_NS, "rect");
    hit.setAttribute("x", String(bandX));
    hit.setAttribute("y", String(MARGIN.top));
    hit.setAttribute("width", String(Math.max(band, 6)));
    hit.setAttribute("height", String(innerHeight));
    hit.setAttribute("class", "column-hit");
    hit.setAttribute("tabindex", "0");
    hit.setAttribute("role", "img");
    hit.setAttribute("aria-label", describeDay(day));
    hit.addEventListener("pointermove", (event) => showTooltip(day, event.clientX, event.clientY));
    hit.addEventListener("pointerleave", hideTooltip);
    hit.addEventListener("focus", () => {
      const box = hit.getBoundingClientRect();
      showTooltip(day, box.left + box.width / 2, box.top + box.height / 2);
    });
    hit.addEventListener("blur", hideTooltip);
    svg.append(hit);
  });

  // Roughly six date ticks, always including the first and last day.
  const tickEvery = Math.max(1, Math.round(daily.length / 6));
  daily.forEach((day, index) => {
    const isEdge = index === 0 || index === daily.length - 1;
    if (!isEdge && index % tickEvery !== 0) return;
    if (!isEdge && index > daily.length - tickEvery) return;
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", String(MARGIN.left + index * band + band / 2));
    label.setAttribute("y", String(baselineY + 16));
    label.setAttribute("text-anchor", index === daily.length - 1 ? "end" : "middle");
    label.setAttribute("class", "axis-text");
    label.textContent = shortDate(day.date);
    svg.append(label);
  });

  holder.replaceChildren(svg);
}

function renderLegend(): void {
  const legend = byId("chart-legend");
  legend.replaceChildren(
    ...SERIES.map((series) => {
      const item = element("span", "legend-item");
      const swatch = element("span", "legend-swatch");
      swatch.style.background = series.color;
      item.append(swatch, document.createTextNode(series.label));
      return item;
    }),
  );
}

function plainRect(x: number, y: number, width: number, height: number): SVGElement {
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("x", String(x));
  rect.setAttribute("y", String(y));
  rect.setAttribute("width", String(width));
  rect.setAttribute("height", String(height));
  return rect;
}

/** The top of a column gets a 4px round; the baseline end stays square. */
function cappedRect(x: number, y: number, width: number, height: number): SVGElement {
  const r = Math.min(CAP_RADIUS, width / 2, height);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    `M ${x} ${y + height} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} ` +
      `L ${x + width - r} ${y} Q ${x + width} ${y} ${x + width} ${y + r} ` +
      `L ${x + width} ${y + height} Z`,
  );
  return path;
}

function showTooltip(day: DailyBucket, clientX: number, clientY: number): void {
  const tooltip = byId("tooltip");
  tooltip.replaceChildren(text("div", "tooltip-title", longDate(day.date)));

  for (const series of SERIES) {
    const row = element("div", "tooltip-row");
    const key = element("span", "tooltip-key");
    key.style.background = series.color;
    row.append(key, text("span", "tooltip-value", String(day[series.key])));
    row.append(text("span", "tooltip-name", series.label));
    tooltip.append(row);
  }

  tooltip.hidden = false;
  const box = tooltip.getBoundingClientRect();
  const left = Math.min(Math.max(clientX + 14, 8), window.innerWidth - box.width - 8);
  const top = Math.min(Math.max(clientY - box.height - 12, 8), window.innerHeight - box.height - 8);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip(): void {
  byId("tooltip").hidden = true;
}

function renderChartTable(summary: ActivitySummary): void {
  const rows = summary.daily.filter((day) => dayTotal(day) > 0);
  byId("chart-table").replaceChildren(
    rows.length === 0
      ? text("p", "empty", "No activity to list.")
      : table(
          ["Day", "Commits", "PRs merged", "Reviews", "Total"],
          rows.map((day) => [
            cell(longDate(day.date)),
            numberCell(day.commitsAuthored),
            numberCell(day.pullRequestsMerged),
            numberCell(day.reviewsGiven),
            numberCell(dayTotal(day)),
          ]),
        ),
  );
}

/* ------------------------------------------------------------------- tables */

function renderPullRequests(summary: ActivitySummary): void {
  const prs = summary.landedPullRequests;
  const count = countNote(prs.length, summary.totals.pullRequestsMerged, "merged");
  byId("prs-sub").textContent =
    count.length === 0 ? "" : `${count} Per-PR lines are GitHub totals before excludePaths.`;

  byId("prs-table").replaceChildren(
    prs.length === 0
      ? text("p", "empty", "No pull requests landed in this window.")
      : table(
          ["Merged", "Pull request", "Time to merge", "GitHub diff", "Files"],
          prs.map((pr) => [
            cell(shortDate(formatLocalDay(pr.mergedAt, summary.window.timeZone)), "meta"),
            linkCell(`${pr.repository}#${pr.number}`, pr.title, pr.url),
            cell(formatHours(pr.mergeHours), "num"),
            diffCell(pr.additions, pr.deletions),
            numberCell(pr.changedFiles),
          ]),
        ),
  );
}

function renderLinear(summary: ActivitySummary): void {
  const issues = summary.linear.completedIssues;
  const coverage = summary.linear.coverage;
  const share = coverage.linkedShare === null ? "—" : `${Math.round(coverage.linkedShare * 100)}%`;
  if (summary.linear.syncStatus === "synced") {
    const completed = countNote(
      issues.length,
      summary.linear.completedIssuesTotal,
      "completed",
    );
    byId("linear-sub").textContent =
      `${completed || "No Linear issues completed in this window."} ` +
      `${coverage.linkedPullRequests}/${coverage.landedPullRequests} landed PRs linked ` +
      `(${share}). A PR counts when its title or branch names a synced issue.`;
  } else {
    byId("linear-sub").textContent =
      `Linear unavailable — ${linearStatusLabel(summary.linear.syncStatus)}. ` +
      "Any rows below are cached; completion and PR coverage are not current.";
  }

  byId("linear-table").replaceChildren(
    issues.length === 0
      ? text(
          "p",
          "empty",
          summary.linear.syncStatus === "synced"
            ? "No Linear issues completed in this window."
            : "No cached Linear issues completed in this window.",
        )
      : table(
          ["Completed", "Issue", "Contributed in this window"],
          issues.map((issue) => {
            const contributions: string[] = [];
            for (const pr of issue.pullRequests) {
              contributions.push(`PR ${pr.repository}#${pr.number} via ${pr.via.join("+")}`);
            }
            for (const commit of issue.commits) {
              contributions.push(`${commit.shortSha} via ${commit.via}`);
            }
            return [
              cell(shortDate(formatLocalDay(issue.completedAt, summary.window.timeZone)), "meta"),
              linkCell(issue.identifier, issue.title, issue.url),
              cell(
                contributions.length === 0
                  ? "no linked PRs or commits in this window"
                  : contributions.join(" · "),
                "meta",
              ),
            ];
          }),
        ),
  );
}

function renderCommits(summary: ActivitySummary): void {  const commits = summary.recentCommits;
  byId("commits-sub").textContent = countNote(
    commits.length,
    summary.totals.commitsAuthored,
    "authored",
  );

  byId("commits-table").replaceChildren(
    commits.length === 0
      ? text("p", "empty", "No commits authored in this window.")
      : table(
          ["Authored", "Commit", "Lines"],
          commits.map((commit) => [
            cell(shortDate(formatLocalDay(commit.authoredAt, summary.window.timeZone)), "meta"),
            linkCell(`${commit.repository} ${commit.shortSha}`, commit.subject, commit.url),
            diffCell(commit.additions, commit.deletions),
          ]),
        ),
  );
}

function renderReviews(summary: ActivitySummary): void {
  const reviews = summary.recentReviews;
  byId("reviews-sub").textContent = countNote(
    reviews.length,
    summary.totals.reviewsGiven,
    "submitted",
  );

  byId("reviews-table").replaceChildren(
    reviews.length === 0
      ? text("p", "empty", "No reviews submitted in this window.")
      : table(
          ["Given", "Pull request", "Verdict"],
          reviews.map((review) => [
            cell(shortDate(formatLocalDay(review.submittedAt, summary.window.timeZone)), "meta"),
            linkCell(
              `${review.repository}#${review.pullRequestNumber}`,
              review.title,
              review.url,
            ),
            cell(review.state.toLowerCase().replaceAll("_", " "), "meta"),
          ]),
        ),
  );
}

function renderRepositories(summary: ActivitySummary): void {
  byId("repos-table").replaceChildren(
    summary.repositories.length === 0
      ? text("p", "empty", "No repositories synced yet.")
      : table(
          [
            "Repository",
            "Checkout",
            "Ref walked",
            "Head date",
            "Commits mine / all",
            "Authors seen",
            "PRs merged",
            "Last synced",
          ],
          summary.repositories.map((repo) => [
            cell(repo.slug ?? repo.key),
            cell(repo.localPath ?? "—", "meta mono"),
            cell(repo.defaultRef ?? "—", "meta"),
            cell(
              repo.headCommittedAt === null
                ? (repo.headSha ?? "").slice(0, 8) || "—"
                : `${shortDate(formatLocalDay(repo.headCommittedAt, summary.window.timeZone))} ` +
                  `${(repo.headSha ?? "").slice(0, 8)}`,
              "meta mono",
            ),
            cell(`${formatCount(repo.commitsAuthored)} / ${formatCount(repo.commitsObserved)}`, "num"),
            cell(repo.authorEmails.join(", ") || "—", "meta"),
            numberCell(repo.pullRequestsMerged),
            cell(repo.lastSyncedAt === null ? "—" : formatRelative(repo.lastSyncedAt), "meta"),
          ]),
        ),
  );
}

function renderDefinitions(summary: ActivitySummary): void {
  const list = byId("definitions");
  const nodes: HTMLElement[] = [];
  for (const [name, description] of Object.entries(summary.definitions)) {
    nodes.push(text("dt", "", humanise(name)), text("dd", "", description));
  }
  list.replaceChildren(...nodes);
}

/* ------------------------------------------------------------------ controls */

function buildRangeControl(): void {
  const control = byId("range-control");
  control.replaceChildren(
    ...RANGES.map((days) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset["value"] = String(days);
      button.textContent = `${days} days`;
      button.addEventListener("click", () => void load(days));
      return button;
    }),
  );
  markSelected("#range-control", String(currentDays));
}

function wireViewToggle(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".view-toggle button")) {
    button.addEventListener("click", () => {
      chartView = button.dataset["view"] === "table" ? "table" : "chart";
      byId("chart-holder").classList.toggle("is-hidden", chartView === "table");
      byId("chart-table").classList.toggle("is-hidden", chartView === "chart");
      for (const sibling of document.querySelectorAll(".view-toggle button")) {
        sibling.classList.toggle("is-selected", sibling === button);
      }
      if (chartView === "chart" && currentSummary !== null) drawChart(currentSummary);
    });
  }
}

function wireThemeToggle(): void {
  const root = document.documentElement;
  byId("theme-toggle").addEventListener("click", () => {
    const next =
      root.dataset["theme"] === "dark"
        ? "light"
        : root.dataset["theme"] === "light"
          ? "auto"
          : "dark";
    if (next === "auto") delete root.dataset["theme"];
    else root.dataset["theme"] = next;
    if (currentSummary !== null) drawChart(currentSummary);
  });
}

function markSelected(selector: string, value: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(`${selector} button`)) {
    button.classList.toggle("is-selected", button.dataset["value"] === value);
  }
}

/* ------------------------------------------------------------------- helpers */

function dayTotal(day: DailyBucket): number {
  return day.commitsAuthored + day.pullRequestsMerged + day.reviewsGiven;
}

function describeDay(day: DailyBucket): string {
  return (
    `${longDate(day.date)}: ${day.commitsAuthored} commits authored, ` +
    `${day.pullRequestsMerged} pull requests merged, ${day.reviewsGiven} reviews given.`
  );
}

/** Axis ceiling on a 1/2/5 ladder, with four steps to it. */
export function niceScale(peak: number): { max: number; step: number } {
  if (peak <= 4) return { max: Math.max(peak, 1), step: 1 };
  const rough = peak / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s * 4 >= peak) ?? magnitude * 10;
  return { max: step * 4, step };
}

function formatCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(1)}K`;
  return value.toLocaleString();
}

function shortDate(isoDay: string): string {
  const date = new Date(`${isoDay}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? isoDay
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function longDate(isoDay: string): string {
  const date = new Date(`${isoDay}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? isoDay
    : date.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
}

function formatRelative(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 36) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function countNote(shown: number, total: number, verb: string): string {
  if (total === 0) return "";
  return shown < total ? `Showing ${shown} of ${total} ${verb}.` : `${total} ${verb}.`;
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

function humanise(camel: string): string {
  const spaced = camel.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------- DOM builders */

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`Missing element #${id}`);
  return el;
}

function element(tag: string, className: string): HTMLElement {
  const el = document.createElement(tag);
  if (className.length > 0) el.className = className;
  return el;
}

/** Always `textContent`: titles and repository names are untrusted API data. */
function text(tag: string, className: string, content: string): HTMLElement {
  const el = element(tag, className);
  el.textContent = content;
  return el;
}

function cell(content: string, className = ""): HTMLTableCellElement {
  const td = document.createElement("td");
  if (className.length > 0) td.className = className;
  td.textContent = content;
  return td;
}

function numberCell(value: number): HTMLTableCellElement {
  return cell(value.toLocaleString(), "num");
}

function diffCell(additions: number, deletions: number): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = "num";
  td.append(
    text("span", "add", `+${additions.toLocaleString()}`),
    document.createTextNode(" "),
    text("span", "del", `−${deletions.toLocaleString()}`),
  );
  return td;
}

function linkCell(label: string, title: string, href: string | null): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = "subject";
  const head = href === null ? element("span", "mono") : document.createElement("a");
  head.textContent = label;
  if (href !== null) {
    (head as HTMLAnchorElement).href = href;
    (head as HTMLAnchorElement).rel = "noreferrer";
    (head as HTMLAnchorElement).target = "_blank";
    head.className = "mono";
  }
  td.append(head);
  if (title.length > 0) {
    td.append(document.createElement("br"), text("span", "", title));
  }
  return td;
}

function table(headers: readonly string[], rows: readonly HTMLTableCellElement[][]): HTMLElement {
  const el = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headers.forEach((header, index) => {
    const th = document.createElement("th");
    th.textContent = header;
    if (index > 0 && /lines|files|commits|reviews|merged|total|time/i.test(header)) {
      th.className = "num";
    }
    headRow.append(th);
  });
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  for (const cells of rows) {
    const tr = document.createElement("tr");
    tr.append(...cells);
    tbody.append(tr);
  }

  el.append(thead, tbody);
  return el;
}

function readDaysFromHash(): number | null {
  const match = /days=(\d+)/.exec(window.location.hash);
  const days = match === null ? Number.NaN : Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(days) && days > 0 ? days : null;
}
