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
  const startDayKey = addDaysToDayKey(endDayKey, -(days - 1));
  const fromMs = startOfLocalDayMs(startDayKey, timeZone);

  return {
    days,
    timeZone,
    startDayKey,
    endDayKey,
    fromMs,
    toMs: nowMs,
    startIso: new Date(fromMs).toISOString(),
    endIso: new Date(nowMs).toISOString(),
    dayKeys: dayKeysBetween(startDayKey, endDayKey),
  };
}

export function parseWindowDays(raw: string | undefined, fallback = DEFAULT_WINDOW_DAYS): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const days = Number.parseInt(raw, 10);
  if (!Number.isInteger(days) || days < 1 || days > 365) return fallback;
  return days;
}
