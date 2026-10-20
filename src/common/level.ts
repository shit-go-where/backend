/**
 * Toilet levels. People type the same floor many ways ("1", "L1", "Level 1", "ground"), which
 * made the duplicate guard miss and left nothing to sort or route by. Everything that writes
 * `Toilet.level` goes through normalizeLevel, and `Toilet.levelOrder` is levelOrder of that.
 *
 * Singapore convention: ground is L1, the floor below it B1 (there is no level 0).
 * frontend/lib/level.ts mirrors this file; keep the two behaving the same.
 */

/** Separators between levels in one value: "B1; L3", "B1, L3", "B1/L3", "B1 & L3", "B1 and L3". */
const LIST_SPLIT = /\s*(?:;|,|\/|&|\band\b)\s*/i;

/** One level, or null when it doesn't look like one. Input is trimmed, lower case, single spaces. */
function normalizeOne(s: string): string | null {
  if (/^(?:ground(?: floor| level)?|g|gf)$/.test(s)) return 'L1';
  if (/^(?:mezzanine|mezz|m)$/.test(s)) return 'M';
  if (s === 'basement') return 'B1';
  const basement = /^(?:basement|b) ?-? ?0*(\d+)$/.exec(s) ?? /^- ?0*(\d+)$/.exec(s);
  if (basement) {
    const n = Number(basement[1]);
    return n > 0 ? `B${n}` : null;
  }
  // "level 3", "lvl 3", "l3", "#03", "#03-12" (a unit number: level 3, unit 12), "3", "03", "3rd floor".
  const level =
    /^(?:level|lvl|lv|l|floor|flr|fl|storey) ?\.? ?0*(\d+)$/.exec(s) ??
    /^# ?0*(\d+)(?:-\w+)?$/.exec(s) ??
    /^0*(\d+)(?:st|nd|rd|th)?(?: (?:floor|storey|level))?$/.exec(s);
  if (level) {
    const n = Number(level[1]);
    // Level 0 is the ground floor in OpenStreetMap's numbering, which is L1 here.
    return `L${Math.max(1, n)}`;
  }
  const unitInBasement = /^# ?b ?0*(\d+)(?:-\w+)?$/.exec(s);
  if (unitInBasement && Number(unitInBasement[1]) > 0) return `B${Number(unitInBasement[1])}`;
  return null;
}

/**
 * "basement 1", "b1", "B01", "-1" → "B1"; "level 3", "l3", "lvl 3", "3", "03", "#03" → "L3";
 * "ground", "g", "gf", "ground floor" → "L1"; "mezzanine", "m" → "M". Lists ("B1, L3", "b1 & 3")
 * become "B1; L3". Anything else is kept as typed (trimmed). Empty → null.
 */
export function normalizeLevel(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const parts = raw
    .split(LIST_SPLIT)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const normalised = parts.map((p) => normalizeOne(p.toLowerCase().replace(/\s+/g, ' ')));
  // Nothing in it reads as a level: keep exactly what was typed ("Block 2/3", "Roof garden").
  if (normalised.every((n) => n === null)) return raw;
  const out: string[] = [];
  normalised.forEach((n, i) => {
    const one = n ?? parts[i];
    if (!out.includes(one)) out.push(one);
  });
  return out.join('; ');
}

/** "B2" → -2, "L3" → 3, "M" → 1.5. */
function orderOne(level: string): number | null {
  if (level === 'M') return 1.5;
  const m = /^([BL])(\d+)$/.exec(level);
  if (!m) return null;
  return m[1] === 'B' ? -Number(m[2]) : Number(m[2]);
}

/**
 * Sort key for a level: B<n> → -n, L<n> → n, M → 1.5; a list → its lowest level; unknown → null.
 * Accepts un-normalised input too (rows written before normalisation).
 */
export function levelOrder(level: string | null | undefined): number | null {
  const norm = normalizeLevel(level);
  if (!norm) return null;
  const orders = norm
    .split('; ')
    .map(orderOne)
    .filter((n): n is number => n !== null);
  return orders.length ? Math.min(...orders) : null;
}

/** The `level` and `levelOrder` columns to write for what someone typed. */
export function levelFields(input: string | null | undefined): { level: string | null; levelOrder: number | null } {
  const level = normalizeLevel(input);
  return { level, levelOrder: levelOrder(level) };
}

/**
 * Floors between two levels. There is no level 0, so B1 → L1 is one floor, not two; the
 * mezzanine sits half a floor above L1.
 */
export function floorsBetween(a: number, b: number): number {
  const storey = (o: number) => (o > 0 ? o - 1 : o);
  return Math.abs(storey(a) - storey(b));
}

/** Whether two level values share a floor ("B1; L3" and "b1" do). Either unknown matches anything. */
export function levelsOverlap(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeLevel(a);
  const nb = normalizeLevel(b);
  if (!na || !nb) return true;
  const set = new Set(na.toUpperCase().split('; '));
  return nb
    .toUpperCase()
    .split('; ')
    .some((l) => set.has(l));
}
