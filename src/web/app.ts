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

import type {
  ActivitySummary,
  MonthlyBucket,
  ShippedCommit,
  ShippedIssue,
  ShippedPullRequest,
} from "../metrics/summary.ts";
import { formatHours, formatLocalDay } from "../report/text.ts";

type SeriesKey = "commitsAuthored" | "pullRequestsMerged" | "reviewsGiven";

interface Series {
  readonly key: SeriesKey;
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

/** One chart column: a day of the daily chart or a month of the trend. */
interface Column {
  readonly tick: string;
  readonly title: string;
  readonly commitsAuthored: number;
  readonly pullRequestsMerged: number;
  readonly reviewsGiven: number;
  /** Drawn with a wash behind it: the trend's months that overlap the selected range. */
  readonly highlighted: boolean;
}

/** A shortcut (`days`) or an explicit pair of local days. */
type Selection = { readonly days: number } | { readonly from: string; readonly to: string };

let selection: Selection = readSelectionFromHash() ?? { days: 30 };
let currentSummary: ActivitySummary | null = null;

void main();

async function main(): Promise<void> {
  buildRangeControl();
  wireRangeForm();
  for (const toggle of document.querySelectorAll<HTMLElement>(".view-toggle")) wireViewToggle(toggle);
  wireThemeToggle();

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (currentSummary !== null) drawCharts(currentSummary);
    }, 120);
  });

  await load(selection);
}

async function load(next: Selection): Promise<void> {
  selection = next;
  const query = new URLSearchParams(
    "days" in next ? { days: String(next.days) } : { from: next.from, to: next.to },
  ).toString();
  window.location.hash = query;
  const main = byId("main");
  main.setAttribute("aria-busy", "true");
  markSelected("#range-control", "days" in next ? String(next.days) : "");

  try {
    const response = await fetch(`/api/summary?${query}`);
    // A hosted account exists from first sign-in, before its collector has published
    // anything. That empty state is the first thing a new account sees, so it needs
    // the next step named rather than a status code at the foot of the page.
    if (response.status === 404) {
      showAwaitingFirstPublication();
      return;
    }
    if (!response.ok) throw new Error(await errorMessage(response));
    currentSummary = (await response.json()) as ActivitySummary;
    render(currentSummary);
  } catch (error) {
    byId("warnings").textContent = `Could not load the summary: ${describe(error)}`;
  } finally {
    main.setAttribute("aria-busy", "false");
  }
}

/**
 * Nothing has been published under this account yet. Reveals the account link,
 * because until `render` runs there is no visible route to the page that mints the
 * first collector token.
 */
function showAwaitingFirstPublication(): void {
  byId("scope-line").textContent =
    "Nothing published yet. Create a collector token on the Account page, then run " +
    "`overview sync` and `overview publish` on the machine you work from.";
  byId("sync-line").textContent = "";
  byId("account-link").hidden = false;
  byId("warnings").textContent = "";
}

function render(summary: ActivitySummary): void {
  const t = summary.totals;

  // Only the hosted read API names an account, so the local dashboard stays link-free.
  const accountLink = byId("account-link");
  accountLink.hidden = summary.account === undefined;
  if (summary.account !== undefined) accountLink.textContent = summary.account.githubLogin;

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

  const period = describePeriod(summary);
  byId("hero-value").textContent = formatCount(t.pullRequestsMerged);
  byId("hero-note").textContent =
    t.pullRequestsMerged === 0
      ? `Nothing merged ${period}.`
      : `Merged ${period} · median ${formatHours(
          summary.mergeTimeHours.median,
        )} from open to merge · ${formatCount(t.pullRequestsOpened)} opened.`;

  const from = byId("range-from") as HTMLInputElement;
  const to = byId("range-to") as HTMLInputElement;
  from.value = summary.window.startDay;
  to.value = summary.window.endDay;

  renderKpis(summary);
  drawCharts(summary);
  renderChartTable(summary);
  renderTrendTable(summary);
  renderShipped(summary);
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

function drawCharts(summary: ActivitySummary): void {
  byId("chart-sub").textContent =
    `Commits, merges and reviews per local calendar day, ${summary.window.startDay} to ` +
    `${summary.window.endDay}.`;
  drawChart(
    byId("chart-holder"),
    summary.daily.map((day) => ({ ...day, tick: shortDate(day.date), title: longDate(day.date), highlighted: false })),
    `Daily activity from ${summary.window.startDay} to ${summary.window.endDay}`,
    `No recorded activity ${describePeriod(summary)}.`,
  );
  renderLegend("chart-legend");

  const trend = summary.trend;
  byId("trend-card").hidden = trend === undefined;
  if (trend === undefined) return;
  byId("trend-sub").textContent =
    `Calendar months from ${trend[0]?.startDay ?? summary.window.startDay} to ${summary.window.endDay}, ` +
    "counted exactly as the totals above. " +
    "Shaded months overlap the selected range; the table adds active days and Linear completions.";
  drawChart(
    byId("trend-holder"),
    trend.map((month) => ({
      ...month,
      tick: monthLabel(month, false),
      title: monthLabel(month, true),
      highlighted: month.endDay >= summary.window.startDay,
    })),
    `Monthly activity to ${summary.window.endDay}`,
    "No recorded activity in these months.",
  );
  renderLegend("trend-legend");
}

function drawChart(holder: HTMLElement, columns: readonly Column[], label: string, empty: string): void {
  if (holder.classList.contains("is-hidden")) return;
  const total = columns.reduce((acc, column) => acc + columnTotal(column), 0);
  if (total === 0) {
    holder.replaceChildren(text("p", "chart-empty", empty));
    return;
  }

  const width = Math.max(holder.clientWidth || 900, 320);
  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const baselineY = MARGIN.top + innerHeight;

  const peak = Math.max(...columns.map(columnTotal));
  const { max: axisMax, step } = niceScale(peak);
  const scale = innerHeight / axisMax;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${CHART_HEIGHT}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${label}. Peak ${peak} events. The table view lists every value.`);

  const band = innerWidth / columns.length;
  const barWidth = Math.max(2, Math.min(MAX_BAR_WIDTH, band - 2));

  columns.forEach((column, index) => {
    if (!column.highlighted) return;
    const wash = plainRect(MARGIN.left + index * band, MARGIN.top, band, innerHeight);
    wash.setAttribute("class", "column-wash");
    svg.append(wash);
  });

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

    const tick = document.createElementNS(SVG_NS, "text");
    tick.setAttribute("x", String(MARGIN.left - 8));
    tick.setAttribute("y", String(y + 4));
    tick.setAttribute("text-anchor", "end");
    tick.setAttribute("class", "axis-text");
    tick.textContent = String(value);
    svg.append(tick);
  }

  columns.forEach((column, index) => {
    const bandX = MARGIN.left + index * band;
    const x = bandX + (band - barWidth) / 2;
    const topKey = SERIES.filter((s) => column[s.key] > 0).at(-1)?.key;

    let cursor = baselineY;
    let isBottomDrawn = true;
    for (const series of SERIES) {
      const value = column[series.key];
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
    hit.setAttribute("aria-label", describeColumn(column));
    hit.addEventListener("pointermove", (event) => showTooltip(column, event.clientX, event.clientY));
    hit.addEventListener("pointerleave", hideTooltip);
    hit.addEventListener("focus", () => {
      const box = hit.getBoundingClientRect();
      showTooltip(column, box.left + box.width / 2, box.top + box.height / 2);
    });
    hit.addEventListener("blur", hideTooltip);
    svg.append(hit);
  });

  // Roughly six ticks, always including the first and last column.
  const tickEvery = Math.max(1, Math.round(columns.length / 6));
  columns.forEach((column, index) => {
    const isEdge = index === 0 || index === columns.length - 1;
    if (!isEdge && index % tickEvery !== 0) return;
    if (!isEdge && index > columns.length - tickEvery) return;
    const tick = document.createElementNS(SVG_NS, "text");
    tick.setAttribute("x", String(MARGIN.left + index * band + band / 2));
    tick.setAttribute("y", String(baselineY + 16));
    tick.setAttribute("text-anchor", index === columns.length - 1 && columns.length > 1 ? "end" : "middle");
    tick.setAttribute("class", "axis-text");
    tick.textContent = column.tick;
    svg.append(tick);
  });

  holder.replaceChildren(svg);
}

function renderLegend(id: string): void {
  const legend = byId(id);
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

function showTooltip(column: Column, clientX: number, clientY: number): void {
  const tooltip = byId("tooltip");
  tooltip.replaceChildren(text("div", "tooltip-title", column.title));

  for (const series of SERIES) {
    const row = element("div", "tooltip-row");
    const key = element("span", "tooltip-key");
    key.style.background = series.color;
    row.append(key, text("span", "tooltip-value", String(column[series.key])));
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
  const rows = summary.daily.filter((day) => columnTotal(day) > 0);
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
            numberCell(columnTotal(day)),
          ]),
        ),
  );
}

function renderTrendTable(summary: ActivitySummary): void {
  const trend = summary.trend ?? [];
  byId("trend-table").replaceChildren(
    trend.length === 0
      ? text("p", "empty", "No months to list.")
      : table(
          ["Month", "PRs merged", "Commits", "Reviews", "Active days", "Linear completed"],
          trend.map((month) => [
            cell(monthLabel(month, true)),
            numberCell(month.pullRequestsMerged),
            numberCell(month.commitsAuthored),
            numberCell(month.reviewsGiven),
            cell(`${month.activeDays} / ${month.days}`, "num"),
            numberCell(month.linearCompleted),
          ]),
        ),
  );
}

/* ------------------------------------------------------------------- tables */

/**
 * The period's work as the ledger links it: issues first, newest first, each with
 * the pull requests and commits that name it; then whatever names no issue. Blank
 * titles stay blank — publication removed them, and nothing here fills them back in.
 */
function renderShipped(summary: ActivitySummary): void {
  const shipped = summary.shipped;
  const issuesHolder = byId("shipped-issues");
  const unlinkedHolder = byId("shipped-unlinked");
  if (shipped === undefined) {
    byId("shipped-sub").textContent =
      "This summary was stored before shipped work existed. Publish again with a current collector.";
    issuesHolder.replaceChildren();
    unlinkedHolder.replaceChildren();
    return;
  }

  const zone = summary.window.timeZone;
  const coverage = summary.linear.coverage;
  const share = coverage.linkedShare === null ? "—" : `${Math.round(coverage.linkedShare * 100)}%`;
  const linear =
    summary.linear.syncStatus === "synced"
      ? ""
      : ` Linear unavailable — ${linearStatusLabel(summary.linear.syncStatus)}; issue details may be stale.`;
  byId("shipped-sub").textContent =
    `${plural(shipped.issues.length, "issue")} · ${coverage.linkedPullRequests}/${coverage.landedPullRequests} ` +
    `landed PRs linked (${share}). Every PR landed and commit authored ${describePeriod(summary)} ` +
    `appears under the issue its title, branch or subject names, or below.${linear}`;

  issuesHolder.replaceChildren(
    shipped.issues.length === 0
      ? text("p", "empty", "No work linked to a Linear issue in this range.")
      : workList(shipped.issues.map((issue) => issueItem(issue, zone))),
  );

  const unlinked: HTMLElement[] = [];
  if (shipped.unlinkedPullRequests.length > 0) {
    unlinked.push(workList(shipped.unlinkedPullRequests.map((pr) => unlinkedPullRequestItem(pr, zone))));
  }
  if (shipped.unlinkedCommits.length > 0) {
    const details = element("details", "work-more");
    details.append(
      text("summary", "", `${plural(shipped.unlinkedCommits.length, "other commit")}, not the squash commit of a landed PR`),
      evidenceList(shipped.unlinkedCommits.map((commit) => commitEvidence(commit, zone))),
    );
    unlinked.push(details);
  }
  unlinkedHolder.replaceChildren(
    ...(unlinked.length === 0 ? [text("p", "empty", "Everything in this range names an issue.")] : unlinked),
  );
}

function issueItem(issue: ShippedIssue, zone: string): HTMLElement {
  const status =
    issue.state === null
      ? "no completion on record · open, or completed before this history"
      : issue.completedInWindow
        ? `${issue.state} ${shortDate(formatLocalDay(issue.completedAt, zone))}`
        : `${issue.state} ${shortDate(formatLocalDay(issue.completedAt, zone))}, outside this range`;
  const evidence = [
    ...issue.pullRequests.flatMap((pr) => [
      pullRequestEvidence(pr, zone),
      ...pr.commits.map((commit) => commitEvidence(commit, zone, true)),
    ]),
    ...issue.commits.map((commit) => commitEvidence(commit, zone)),
  ];
  return workItem(
    formatLocalDay(issue.shippedAt, zone),
    anchor(issue.identifier, issue.url),
    issue.title,
    status,
    evidence.length === 0
      ? text("p", "work-none", "No pull request or commit in this range names it.")
      : evidenceList(evidence),
  );
}

function unlinkedPullRequestItem(pr: ShippedPullRequest, zone: string): HTMLElement {
  return workItem(
    formatLocalDay(pr.mergedAt, zone),
    anchor(`${pr.repository}#${pr.number}`, pr.url),
    pr.title,
    `merged after ${formatHours(pr.mergeHours)} · +${pr.additions.toLocaleString()} −${pr.deletions.toLocaleString()}`,
    pr.commits.length === 0 ? null : evidenceList(pr.commits.map((commit) => commitEvidence(commit, zone, true))),
  );
}

function workItem(
  day: string,
  label: HTMLElement,
  title: string,
  status: string,
  evidence: HTMLElement | null,
): HTMLElement {
  const item = element("li", "work-item");
  const head = element("div", "work-head");
  head.append(text("span", "work-date", shortDate(day)), label);
  if (title.length > 0) head.append(text("span", "work-title", title));
  head.append(text("span", "work-status", status));
  item.append(head);
  if (evidence !== null) item.append(evidence);
  return item;
}

function pullRequestEvidence(pr: ShippedPullRequest, zone: string): HTMLElement {
  return evidenceRow(
    "PR",
    anchor(`${pr.repository}#${pr.number}`, pr.url),
    pr.title,
    `merged ${shortDate(formatLocalDay(pr.mergedAt, zone))} · +${pr.additions.toLocaleString()} ` +
      `−${pr.deletions.toLocaleString()}${pr.via.length === 0 ? "" : ` · named in ${pr.via.map(viaLabel).join(" and ")}`}`,
  );
}

function commitEvidence(commit: ShippedCommit, zone: string, underPullRequest = false): HTMLElement {
  return evidenceRow(
    underPullRequest ? "↳ merged" : "commit",
    anchor(`${commit.repository} ${commit.shortSha}`, commit.url),
    commit.subject,
    `authored ${shortDate(formatLocalDay(commit.authoredAt, zone))} · +${commit.additions.toLocaleString()} ` +
      `−${commit.deletions.toLocaleString()}${commit.via === null ? "" : ` · ${viaLabel(commit.via)}`}`,
  );
}

function evidenceRow(kind: string, label: HTMLElement, title: string, meta: string): HTMLElement {
  const row = element("li", "evidence");
  row.append(text("span", "evidence-kind", kind), label);
  if (title.length > 0) row.append(text("span", "evidence-title", title));
  row.append(text("span", "evidence-meta", meta));
  return row;
}

function workList(items: readonly HTMLElement[]): HTMLElement {
  const list = element("ol", "work-list");
  list.append(...items);
  return list;
}

function evidenceList(rows: readonly HTMLElement[]): HTMLElement {
  const list = element("ul", "evidence-list");
  list.append(...rows);
  return list;
}

function anchor(label: string, href: string | null): HTMLElement {
  if (href === null) return text("span", "mono", label);
  const link = document.createElement("a");
  link.textContent = label;
  link.href = href;
  link.rel = "noreferrer";
  link.target = "_blank";
  link.className = "mono";
  return link;
}

function viaLabel(via: ShippedPullRequest["via"][number] | NonNullable<ShippedCommit["via"]>): string {
  switch (via) {
    case "pr_title":
      return "title";
    case "pr_branch":
      return "branch";
    case "commit_subject":
      return "named in subject";
    case "pr_merge_commit":
      return "squash commit of the PR";
  }
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
      button.addEventListener("click", () => void load({ days }));
      return button;
    }),
  );
  markSelected("#range-control", "days" in selection ? String(selection.days) : "");
}

function wireRangeForm(): void {
  const from = byId("range-from") as HTMLInputElement;
  const to = byId("range-to") as HTMLInputElement;
  const today = new Date().toLocaleDateString("en-CA");
  from.max = today;
  to.max = today;
  byId("range-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (from.value.length === 0 || to.value.length === 0) return;
    const [start, end] = from.value <= to.value ? [from.value, to.value] : [to.value, from.value];
    void load({ from: start, to: end });
  });
}

/** A card's Chart/Table pair; the chart redraws on show because it measures its holder. */
function wireViewToggle(toggle: HTMLElement): void {
  const chart = byId(toggle.dataset["chart"] ?? "");
  const tableHolder = byId(toggle.dataset["table"] ?? "");
  for (const button of toggle.querySelectorAll<HTMLButtonElement>("button")) {
    button.addEventListener("click", () => {
      const showTable = button.dataset["view"] === "table";
      chart.classList.toggle("is-hidden", showTable);
      tableHolder.classList.toggle("is-hidden", !showTable);
      for (const sibling of toggle.querySelectorAll("button")) {
        sibling.classList.toggle("is-selected", sibling === button);
      }
      if (!showTable && currentSummary !== null) drawCharts(currentSummary);
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
    if (currentSummary !== null) drawCharts(currentSummary);
  });
}

function markSelected(selector: string, value: string): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(`${selector} button`)) {
    button.classList.toggle("is-selected", button.dataset["value"] === value);
  }
}

/* ------------------------------------------------------------------- helpers */

function columnTotal(column: Pick<Column, SeriesKey>): number {
  return column.commitsAuthored + column.pullRequestsMerged + column.reviewsGiven;
}

function describeColumn(column: Column): string {
  return (
    `${column.title}: ${column.commitsAuthored} commits authored, ` +
    `${column.pullRequestsMerged} pull requests merged, ${column.reviewsGiven} reviews given.`
  );
}

/** "in the last 30 days" for a shortcut, "from Sep 1 to Sep 24" for a range. */
function describePeriod(summary: ActivitySummary): string {
  return "days" in selection
    ? `in the last ${summary.window.days} days`
    : `from ${shortDate(summary.window.startDay)} to ${shortDate(summary.window.endDay)}`;
}

function monthLabel(month: MonthlyBucket, long: boolean): string {
  const date = new Date(`${month.startDay}T12:00:00Z`);
  const name = date.toLocaleDateString(undefined, {
    month: "short",
    ...(long ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
  if (!long) return name;
  const firstDay = Number(month.startDay.slice(8, 10));
  const lastDay = Number(month.endDay.slice(8, 10));
  const monthLength = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const from = firstDay > 1 ? `from the ${ordinal(firstDay)}` : "";
  const to = lastDay < monthLength ? `to the ${ordinal(lastDay)}` : "";
  return from || to ? `${name} (${[from, to].filter(Boolean).join(" ")})` : name;
}

function ordinal(day: number): string {
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${suffix}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON; the status is all there is.
  }
  return `The server answered ${response.status}.`;
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
    if (index > 0 && /lines|files|commits|reviews|merged|total|time|days|completed/i.test(header)) {
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

function readSelectionFromHash(): Selection | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const from = params.get("from");
  const to = params.get("to");
  if (from !== null && to !== null) return { from, to };
  const days = Number.parseInt(params.get("days") ?? "", 10);
  return Number.isInteger(days) && days > 0 ? { days } : null;
}
