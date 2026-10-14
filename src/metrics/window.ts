/**
 * Window arithmetic.
 *
 * "Last 30 days" here means the 30 local calendar days ending today, today
 * included. That definition is the one that makes "active days" comparable to the
 * window length — 18 of 30 — and it is the one a person means when they ask what
 * they shipped this month.
 */

import {
  addDaysToDayKey,
  currentTimeZone,
  dayKeysBetween,
  localDayKey,
  startOfLocalDayMs,
} from "../domain/time.ts";

export const SUPPORTED_WINDOW_DAYS = [7, 30, 90] as const;
export const DEFAULT_WINDOW_DAYS = 30;

export interface MetricWindow {
  readonly days: number;
  readonly timeZone: string;
  /** First local day in the window, `YYYY-MM-DD`. */
  readonly startDayKey: string;
  /** Last local day in the window (today), `YYYY-MM-DD`. */
  readonly endDayKey: string;
  /** Local midnight starting `startDayKey`. */
  readonly fromMs: number;
  /** "Now" — the window is open-ended at the top, not padded to end of day. */
  readonly toMs: number;
  readonly startIso: string;
  readonly endIso: string;
  /** Every day in the window, ascending. Charts render a bar per entry, gaps included. */
  readonly dayKeys: readonly string[];
}

export function createWindow(
  days: number,
  nowMs: number = Date.now(),
  timeZone: string = currentTimeZone(),
): MetricWindow {
  if (!Number.isInteger(days) || days <= 0) {
    throw new RangeError(`Window must be a positive whole number of days, got ${days}.`);
  }
  const endDayKey = localDayKey(nowMs, timeZone);
  return createRangeWindow(addDaysToDayKey(endDayKey, -(days - 1)), endDayKey, nowMs, timeZone);
}

export function createRangeWindow(
  startDayKey: string,
  endDayKey: string,
  nowMs: number = Date.now(),
  timeZone: string = currentTimeZone(),
): MetricWindow {
  if (!isDayKey(startDayKey) || !isDayKey(endDayKey)) {
    throw new RangeError(`A range needs two YYYY-MM-DD days, got ${startDayKey}..${endDayKey}.`);
  }
  const today = localDayKey(nowMs, timeZone);
  const lastDayKey = endDayKey < today ? endDayKey : today;
  if (startDayKey > lastDayKey) {
    throw new RangeError(`A range must start on or before today and its end, got ${startDayKey}..${endDayKey}.`);
  }
  const fromMs = startOfLocalDayMs(startDayKey, timeZone);
  const toMs =
    lastDayKey === today ? nowMs : startOfLocalDayMs(addDaysToDayKey(lastDayKey, 1), timeZone) - 1;
  const dayKeys = dayKeysBetween(startDayKey, lastDayKey);

  return {
    days: dayKeys.length,
    timeZone,
    startDayKey,
    endDayKey: lastDayKey,
    fromMs,
    toMs,
    startIso: new Date(fromMs).toISOString(),
    endIso: new Date(toMs).toISOString(),
    dayKeys,
  };
}

export function parseRangeWindow(
  from: string | null,
  to: string | null,
  nowMs: number,
  timeZone: string,
): MetricWindow | null {
  if (from === null || to === null || !isDayKey(from) || !isDayKey(to)) return null;
  const today = localDayKey(nowMs, timeZone);
  if (from > to || from > today) return null;
  const last = to < today ? to : today;
  if (last > addDaysToDayKey(from, MAX_RANGE_DAYS - 1)) return null;
  return createRangeWindow(from, to, nowMs, timeZone);
}

export const MAX_RANGE_DAYS = 366;

export const RANGE_ERROR =
  `from and to must be YYYY-MM-DD days, from no later than to or today, ` +
  `at most ${MAX_RANGE_DAYS} days apart.`;

function isDayKey(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    addDaysToDayKey(value, 0) === value
  );
}

export const TREND_MONTHS = 12;

export function monthlyWindows(window: MetricWindow, historyFromDay: string | null): MetricWindow[] {
  const lastMonth = monthStart(window.endDayKey);
  const windows: MetricWindow[] = [];
  for (let month = trendStartDayKey(window); month <= lastMonth; month = addMonths(month, 1)) {
    const monthEnd = addDaysToDayKey(addMonths(month, 1), -1);
    if (historyFromDay !== null && monthEnd < historyFromDay) continue;
    const start = historyFromDay !== null && month < historyFromDay ? historyFromDay : month;
    const end = monthEnd < window.endDayKey ? monthEnd : window.endDayKey;
    if (start > end) continue;
    // `window.toMs` falls on the window's last day, so it stands in for "now".
    windows.push(createRangeWindow(start, end, window.toMs, window.timeZone));
  }
  return windows;
}

export function historyRange(
  window: MetricWindow,
  nowMs: number,
  historyFromMs: number | null,
): { readonly fromMs: number; readonly toMs: number; readonly fromDay: string; readonly toDay: string } {
  const zone = window.timeZone;
  const trendStart = trendStartDayKey(window);
  const trendStartMs = startOfLocalDayMs(trendStart, zone);
  const toMs = Math.max(nowMs, window.toMs);
  const range = { toMs, toDay: localDayKey(toMs, zone) };
  if (historyFromMs === null || historyFromMs <= trendStartMs) {
    return { ...range, fromMs: trendStartMs, fromDay: trendStart };
  }
  const historyDay = localDayKey(historyFromMs, zone);
  const wholeDay =
    startOfLocalDayMs(historyDay, zone) === historyFromMs ? historyDay : addDaysToDayKey(historyDay, 1);
  return { ...range, fromMs: historyFromMs, fromDay: wholeDay };
}

function trendStartDayKey(window: MetricWindow): string {
  const byLength = addMonths(monthStart(window.endDayKey), -(TREND_MONTHS - 1));
  const rangeStart = monthStart(window.startDayKey);
  return rangeStart < byLength ? rangeStart : byLength;
}

function monthStart(dayKey: string): string {
  return `${dayKey.slice(0, 7)}-01`;
}

function addMonths(firstOfMonth: string, months: number): string {
  const index = Number(firstOfMonth.slice(0, 4)) * 12 + Number(firstOfMonth.slice(5, 7)) - 1 + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

export function parseWindowDays(raw: string | undefined, fallback = DEFAULT_WINDOW_DAYS): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const days = Number.parseInt(raw, 10);
  if (!Number.isInteger(days) || days < 1 || days > 365) return fallback;
  return days;
}
