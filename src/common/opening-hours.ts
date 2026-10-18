/**
 * Opening hours evaluation in Singapore time (UTC+8, no DST).
 *
 * Stored format (Venue.openingHours / Toilet.openingHours), see API_CONTRACT.md:
 *   { type: 'always' }
 *   { type: 'weekly', periods: { days: number[]; open: 'HH:MM'; close: 'HH:MM' }[], inferred?: boolean }
 *       days: 0=Sun..6=Sat. close <= open means the period runs past midnight into the next day.
 *       close may be '24:00'.
 *   { type: 'osm', value: string }  raw OSM opening_hours, best-effort parsed.
 */

export interface WeeklyPeriod {
  days: number[];
  open: string;
  close: string;
}

export type OpeningHours =
  | { type: 'always' }
  | { type: 'weekly'; periods: WeeklyPeriod[]; inferred?: boolean }
  | { type: 'osm'; value: string };

const SGT_OFFSET_MS = 8 * 3_600_000;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/** Minutes since midnight, or null if malformed. Accepts 24:00 (=1440). */
export function parseTime(s: string): number | null {
  const m = TIME_RE.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/** Day of week (0=Sun) and minutes since midnight in Singapore time. */
export function sgtClock(at: Date): { day: number; minutes: number } {
  const local = new Date(at.getTime() + SGT_OFFSET_MS);
  return { day: local.getUTCDay(), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

function isValidDay(d: unknown): d is number {
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6;
}

/** Evaluates weekly periods. Returns null if any period is malformed. */
function openInPeriods(periods: unknown, at: Date): boolean | null {
  if (!Array.isArray(periods)) return null;
  const { day, minutes } = sgtClock(at);
  const prevDay = (day + 6) % 7;
  let open = false;
  for (const p of periods as Partial<WeeklyPeriod>[]) {
    if (!p || !Array.isArray(p.days) || !p.days.every(isValidDay)) return null;
    const o = typeof p.open === 'string' ? parseTime(p.open) : null;
    const c = typeof p.close === 'string' ? parseTime(p.close) : null;
    if (o === null || c === null || o >= 1440) return null;
    if (c > o) {
      if (p.days.includes(day) && minutes >= o && minutes < c) open = true;
    } else {
      // Crosses midnight (or open === close: a full 24h block starting at `open`).
      if (p.days.includes(day) && minutes >= o) open = true;
      if (p.days.includes(prevDay) && minutes < c) open = true;
    }
  }
  return open;
}

/**
 * Is the place open at `at`? null = unknown (no data or unparseable).
 */
export function isOpenAt(hours: OpeningHours | null | undefined, at: Date): boolean | null {
  if (!hours || typeof hours !== 'object') return null;
  switch (hours.type) {
    case 'always':
      return true;
    case 'weekly':
      return openInPeriods(hours.periods, at);
    case 'osm': {
      if (typeof hours.value !== 'string') return null;
      const parsed = parseOsmOpeningHours(hours.value);
      if (parsed === null) return null;
      if (parsed === 'always') return true;
      return openInPeriods(parsed, at);
    }
    default:
      return null;
  }
}

// ───────────────────────────── OSM parser ─────────────────────────────

const OSM_DAYS: Record<string, number> = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
const DAY_TOKEN = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/;
const RANGE_RE = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/;

function expandDays(selector: string): number[] | null {
  const days = new Set<number>();
  for (const part of selector.split(',')) {
    const tok = part.trim();
    if (tok === 'PH' || tok === 'SH') continue; // public/school holidays: ignored (best effort)
    const m = DAY_TOKEN.exec(tok);
    if (!m) return null;
    const from = OSM_DAYS[m[1]];
    const to = m[2] ? OSM_DAYS[m[2]] : from;
    // Ranges may wrap (Fr-Mo).
    for (let d = from; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === to) break;
    }
  }
  return [...days];
}

/**
 * Best-effort parse of an OSM opening_hours string into weekly periods.
 * Supports: "24/7", day selectors (Mo-Fr, Sa,Su, Fr-Mo, PH ignored), multiple time ranges
 * ("08:00-12:00,13:00-17:00"), "off"/"closed", rules separated by ";" (later rules override
 * earlier ones for the days they name), ranges past midnight ("18:00-02:00").
 * Returns 'always', a list of periods, or null when anything is not understood.
 */
export function parseOsmOpeningHours(value: string): WeeklyPeriod[] | 'always' | null {
  const src = value.trim();
  if (!src) return null;
  if (src === '24/7') return 'always';

  // A comma directly after a time and before a day token separates rules too.
  const rules = src
    .split(/;|(?<=\d),\s*(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)\b)/)
    .map((r) => r.trim())
    .filter(Boolean);
  if (rules.length === 0) return null;

  const perDay: ({ open: string; close: string }[] | undefined)[] = Array.from({ length: 7 }, () => undefined);
  let sawAny = false;

  for (const rule of rules) {
    if (rule === '24/7') {
      for (let d = 0; d < 7; d++) perDay[d] = [{ open: '00:00', close: '24:00' }];
      sawAny = true;
      continue;
    }
    const tokens = rule.split(/\s+/);
    let days: number[] = [0, 1, 2, 3, 4, 5, 6];
    let i = 0;
    // A leading day selector: anything that does not start with a digit and is not off/closed.
    if (tokens[0] && !/^\d/.test(tokens[0]) && !/^(off|closed)$/i.test(tokens[0])) {
      const expanded = expandDays(tokens[0]);
      if (expanded === null) return null;
      days = expanded;
      i = 1;
      if (days.length === 0) continue; // e.g. "PH off" only
    }
    const rest = tokens.slice(i).join(' ').trim();
    let intervals: { open: string; close: string }[];
    if (rest === '') {
      // "Mo-Fr" with no time means all day in OSM.
      intervals = [{ open: '00:00', close: '24:00' }];
    } else if (/^(off|closed)$/i.test(rest)) {
      intervals = [];
    } else {
      intervals = [];
      for (const part of rest.split(',')) {
        const m = RANGE_RE.exec(part.trim());
        if (!m) return null;
        const o = parseTime(m[1]);
        const c = parseTime(m[2]);
        if (o === null || c === null || o >= 1440) return null;
        // OSM allows "18:00-26:00" style; we only accept <= 24:00 and wrap via close <= open.
        intervals.push({ open: m[1].padStart(5, '0'), close: m[2].padStart(5, '0') });
      }
    }
    for (const d of days) perDay[d] = intervals;
    sawAny = true;
  }
  if (!sawAny) return null;

  const periods: WeeklyPeriod[] = [];
  perDay.forEach((intervals, d) => {
    for (const iv of intervals ?? []) periods.push({ days: [d], open: iv.open, close: iv.close });
  });
  return periods;
}
