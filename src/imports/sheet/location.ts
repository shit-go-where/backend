import { slugify } from '../lib/slug.js';

export const LINE_CODES = ['NSL', 'EWL', 'NEL', 'CCL', 'DTL', 'TEL'] as const;
export type LineCode = (typeof LINE_CODES)[number];

export const SHEET_TYPE_MAP = {
  MRT: 'MRT_STATION',
  Mall: 'MALL',
  BI: 'BUS_INTERCHANGE',
  HC: 'HAWKER_CENTRE',
  CS: 'COFFEESHOP',
  CC: 'COMMUNITY_CLUB',
} as const;
export type SheetTypeCode = keyof typeof SHEET_TYPE_MAP;
export type CuratedVenueType = (typeof SHEET_TYPE_MAP)[SheetTypeCode];

export function isSheetTypeCode(s: string): s is SheetTypeCode {
  return Object.prototype.hasOwnProperty.call(SHEET_TYPE_MAP, s.trim());
}

const LINE_RE = new RegExp(`\\b(${LINE_CODES.join('|')})\\b`, 'g');

/** "NSL, EWL" / "DTL / CCL" / "CCL/NEL" -> ["NSL","EWL"] ... (deduped, in order). */
export function splitLines(s: string): LineCode[] {
  const out: LineCode[] = [];
  for (const m of s.toUpperCase().matchAll(LINE_RE)) {
    const code = m[1] as LineCode;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

export interface ParsedLocation {
  /** Original cell, whitespace-normalised. */
  original: string;
  /** Venue name without lines / level / type suffix, e.g. "Outram Park", "Jewel", "Choa Chu Kang". */
  name: string;
  lines: LineCode[];
  /** Mall level such as "L3" / "B1". */
  level: string | null;
  /** Text after the line codes that identifies a separate toilet, e.g. "Linkway". */
  suffix: string | null;
}

/**
 * Parse a fieldwork "Location" cell.
 *  "Jurong East NSL, EWL"     -> { name: "Jurong East", lines: [NSL, EWL] }
 *  "Marina Bay TEL Linkway"   -> { name: "Marina Bay", lines: [TEL], suffix: "Linkway" }
 *  "Jewel L3"                 -> { name: "Jewel", level: "L3" }
 *  "HDB Hub (Toa Payoh) L1"   -> { name: "HDB Hub (Toa Payoh)", level: "L1" }
 */
export function parseLocation(raw: string): ParsedLocation {
  const original = raw.replace(/\s+/g, ' ').trim();
  let rest = original;
  let level: string | null = null;
  const lv = /\s+((?:B|L)\d{1,2})$/i.exec(rest);
  if (lv) {
    level = lv[1]!.toUpperCase();
    rest = rest.slice(0, lv.index).trim();
  }
  const lines = splitLines(rest);
  let suffix: string | null = null;
  if (lines.length) {
    const matches = [...rest.matchAll(new RegExp(LINE_RE.source, 'gi'))];
    const first = matches[0]!;
    const last = matches[matches.length - 1]!;
    const after = rest
      .slice(last.index! + last[0].length)
      .replace(/^[\s,/&]+/, '')
      .trim();
    suffix = after || null;
    rest = rest.slice(0, first.index).replace(/[\s,/&]+$/, '').trim();
  }
  return { original, name: rest, lines, level, suffix };
}

/** Expand short forms used in the sheet into display names. */
export function displayName(name: string, type: CuratedVenueType): string {
  if (type === 'BUS_INTERCHANGE') return name.replace(/\s+BI$/i, '') + ' Bus Interchange';
  if (type === 'COMMUNITY_CLUB') return name.replace(/\s+CC$/i, '') + ' Community Club';
  return name;
}

const TYPE_PREFIX: Record<CuratedVenueType, string> = {
  MRT_STATION: 'mrt',
  MALL: 'mall',
  BUS_INTERCHANGE: 'bi',
  HAWKER_CENTRE: 'hc',
  COFFEESHOP: 'cs',
  COMMUNITY_CLUB: 'cc',
};

/** Stable venue key: one per physical place. "Outram Park EWL"/"NEL"/"TEL" all -> "mrt-outram-park". */
export function venueKeyFor(name: string, type: CuratedVenueType): string {
  return `${TYPE_PREFIX[type]}-${slugify(displayName(name, type))}`;
}

/** Stable toilet sourceKey: "sheet:" + slug of the whole Location cell. */
export function toiletSourceKey(location: string): string {
  return `sheet:${slugify(location)}`;
}

/** OneMap query for a venue. */
export function geocodeQueryFor(name: string, type: CuratedVenueType): { strategy: 'mrt' | 'place'; query: string } {
  if (type === 'MRT_STATION') return { strategy: 'mrt', query: `${name} MRT STATION` };
  if (type === 'COFFEESHOP') {
    // "Kim San Leng @ Bukit Panjang Blk 259" / "Eunos Block 2A Kimly": search by block when present.
    const blk = /\b(?:blk|block)\s*(\d+[A-Z]?)\b/i.exec(name);
    if (blk) {
      const area = name
        .replace(blk[0], ' ')
        .replace(/.*@/, '')
        .replace(/\b(kimly|kopi|pte|ltd)\b\.?/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { strategy: 'place', query: `${blk[1]} ${area}`.trim() };
    }
  }
  return { strategy: 'place', query: displayName(name, type) };
}

export interface GroupableRow {
  type: CuratedVenueType;
  parsed: ParsedLocation;
}

/** Group rows into venues: same type + same normalised name -> same venue key. */
export function groupVenues<T extends GroupableRow>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = venueKeyFor(r.parsed.name, r.type);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  return groups;
}

/**
 * Toilet label inside a venue. Needed when the venue has several toilets or serves more lines
 * than this toilet: "EWL side", "TEL Linkway". Otherwise null.
 */
export function toiletLabel(parsed: ParsedLocation, venueLines: string[], toiletsAtVenue: number): string | null {
  if (!parsed.lines.length) return null;
  const needs = toiletsAtVenue > 1 || venueLines.some((l) => !parsed.lines.includes(l as LineCode));
  if (!needs && !parsed.suffix) return null;
  const lines = parsed.lines.join('/');
  return parsed.suffix ? `${lines} ${parsed.suffix}` : `${lines} side`;
}
