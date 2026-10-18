/** Singapore time helpers (UTC+8, no DST). Pure. */

export const SGT_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/** Days since epoch in Singapore local time. */
export function sgtDayNumber(d: Date): number {
  return Math.floor((d.getTime() + SGT_OFFSET_MS) / DAY_MS);
}

/** 'YYYY-MM-DD' of the Singapore calendar day containing d. */
export function sgtDayKey(d: Date): string {
  return new Date(d.getTime() + SGT_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC instant of 00:00 SGT on the Singapore day containing d. */
export function sgtDayStart(d: Date): Date {
  return new Date(sgtDayNumber(d) * DAY_MS - SGT_OFFSET_MS);
}

/** Hour 0-23 in Singapore time. */
export function sgtHour(d: Date): number {
  return new Date(d.getTime() + SGT_OFFSET_MS).getUTCHours();
}

/** Longest run of consecutive Singapore calendar days that have at least one timestamp. */
export function longestSgtDayStreak(dates: Date[]): number {
  const days = [...new Set(dates.map(sgtDayNumber))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}
