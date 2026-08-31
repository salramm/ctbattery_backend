/**
 * Date math for the lifecycle engine. All timestamps are UTC (01); rendering in
 * America/New_York happens at the edge, never here.
 */

export function addDays(from: Date, days: number): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** Business days: skip Saturday and Sunday. Negative counts walk backwards. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  const step = days < 0 ? -1 : 1;
  let remaining = Math.abs(days);
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + step);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return d;
}

/** Whole days between two instants, rounded down. Negative when `to` is past. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}
