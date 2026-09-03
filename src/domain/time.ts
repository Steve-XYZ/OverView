/** Time helpers shared by ingestion, storage and metrics. */

export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/** Parse an ISO 8601 timestamp to epoch ms. Throws rather than storing a silent NaN. */
export function toEpochMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Not an ISO 8601 timestamp: ${JSON.stringify(iso)}`);
  return ms;
}

/** Normalise a timestamp to UTC ISO with milliseconds, for stable storage and sorting. */
export function toIsoUtc(iso: string): string {
  return new Date(toEpochMs(iso)).toISOString();
}

export function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Local calendar day (`YYYY-MM-DD`) for an instant.
 *
 * Day bucketing happens in the viewer's zone, not UTC: a commit at 21:00 local on a
 * Friday in UTC-5 lands on Saturday in UTC, and "active days" has to agree with the
 * calendar the user lived through.
 */
export function localDayKey(epochMs: number, timeZone: string = currentTimeZone()): string {
  return dayKeyFormatter(timeZone).format(new Date(epochMs));
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayKeyFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = dayFormatters.get(timeZone);
  if (fmt === undefined) {
    // en-CA renders as YYYY-MM-DD.
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Offset of `timeZone` from UTC at the given instant, in ms (east of UTC is positive). */
export function zoneOffsetMs(epochMs: number, timeZone: string = currentTimeZone()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));

  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? 0 : Number(part.value);
  };

  const asIfUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
  // Round to the second: formatToParts drops sub-second precision.
  return asIfUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Epoch ms of local midnight starting the given `YYYY-MM-DD` in `timeZone`. */
export function startOfLocalDayMs(dayKey: string, timeZone: string = currentTimeZone()): number {
  const asUtc = Date.parse(`${dayKey}T00:00:00Z`);
  if (Number.isNaN(asUtc)) throw new Error(`Not a YYYY-MM-DD day key: ${JSON.stringify(dayKey)}`);
  // One refinement pass settles the DST-boundary case where the first guess lands
  // on the other side of a transition.
  const first = asUtc - zoneOffsetMs(asUtc, timeZone);
  return asUtc - zoneOffsetMs(first, timeZone);
}

/** Shift a `YYYY-MM-DD` key by whole calendar days. Pure calendar arithmetic. */
export function addDaysToDayKey(dayKey: string, days: number): string {
  const asUtc = Date.parse(`${dayKey}T00:00:00Z`);
  if (Number.isNaN(asUtc)) throw new Error(`Not a YYYY-MM-DD day key: ${JSON.stringify(dayKey)}`);
  return new Date(asUtc + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Every `YYYY-MM-DD` from `fromKey` to `toKey` inclusive. */
export function dayKeysBetween(fromKey: string, toKey: string): string[] {
  const keys: string[] = [];
  for (let key = fromKey; key <= toKey; key = addDaysToDayKey(key, 1)) {
    keys.push(key);
    if (keys.length > 5000) throw new Error(`Day range too large: ${fromKey}..${toKey}`);
  }
  return keys;
}
