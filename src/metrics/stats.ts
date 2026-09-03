/** Summary statistics. Small enough to read, so small enough to trust. */

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/**
 * Linear-interpolated percentile over a copy of the input.
 *
 * Merge time is heavily right-skewed — one pull request that sat over a holiday
 * drags a mean far from anything the developer experienced — so the dashboard
 * reports the median and p75 and never a mean.
 */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? null;

  const position = (sorted.length - 1) * Math.min(Math.max(fraction, 0), 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower];
  const high = sorted[upper];
  if (low === undefined || high === undefined) return null;
  return lower === upper ? low : low + (high - low) * (position - lower);
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 0.5);
}

export function minOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

export function maxOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}
