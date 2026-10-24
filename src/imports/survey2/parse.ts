/**
 * Pure helpers for the expanded Aug-Oct 2024 survey (`survey2:normalise`): checklist splitting,
 * timestamps, Location Code prefixes, names, levels and labels. No I/O.
 */
import type { FeatureName } from '../curated/schema.js';
import { normalizeLevel } from '../../common/level.js';
import { nameKey, slugify } from '../lib/slug.js';
import { splitLines, type LineCode } from '../sheet/location.js';
import { EXPANDED_FACILITIES, EXPANDED_REASONS, EXPANDED_TOILETRIES } from '../../toilets/survey-items.js';
import type { SurveySex } from '../../generated/prisma/enums.js';

export const NONE_OF_THE_ABOVE = 'None of the Above';

// ───────────────────────────── checklists ─────────────────────────────

export interface SplitChecklist {
  /** Canonical item text, in list order, each at most once. */
  items: string[];
  /** Whatever is left once the known items are taken out ("Others" free text), or null. */
  rest: string | null;
  /** "None of the Above" was ticked (dropped from `items`). */
  none: boolean;
}

/**
 * Split a Google Forms checkbox cell ("A, B, Others text") against the known item list. Items are
 * joined with ", " and some contain commas themselves ("... (floor, walls, wall tiles, ...)"), so
 * known items are cut out first (longest first, case-insensitive, only at ", " boundaries) and only
 * the remainder is treated as free text.
 */
export function splitChecklist(cell: string, known: readonly string[]): SplitChecklist {
  let text = cell.replace(/\s+/g, ' ').trim();
  const found = new Set<string>();
  let none = false;
  const candidates = [...known, NONE_OF_THE_ABOVE].sort((a, b) => b.length - a.length);
  for (const item of candidates) {
    for (;;) {
      const at = findAtBoundary(text, item.toLowerCase());
      if (at < 0) break;
      if (item === NONE_OF_THE_ABOVE) none = true;
      else found.add(item);
      // Leave a separator so neighbours stay apart.
      text = `${text.slice(0, at)}${SEP}${text.slice(at + item.length)}`;
    }
  }
  const rest = text
    .split(SEP)
    .map((s) => s.replace(/^[\s,]+|[\s,]+$/g, ''))
    .filter(Boolean)
    .join(', ');
  return { items: known.filter((k) => found.has(k)), rest: rest || null, none };
}

/** Marks where an item was cut out: a private-use character, never in the sheet. */
const SEP = String.fromCharCode(0xe000);

/** Index of `needle` (lower case) in `text` where it starts at 0 or after ", " and ends at the end or before ",". */
function findAtBoundary(text: string, needle: string): number {
  const hay = text.toLowerCase();
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return -1;
    const head = hay.slice(0, i).trimEnd();
    const tail = hay.slice(i + needle.length).trimStart();
    const before = head === '' || head.endsWith(',') || head.endsWith(SEP);
    const after = tail === '' || tail.startsWith(',') || tail.startsWith(SEP);
    if (before && after) return i;
    from = i + 1;
  }
}

export const REASON_ITEMS = EXPANDED_REASONS.map(([n]) => n);
export const TOILETRY_ITEMS = EXPANDED_TOILETRIES.map(([n]) => n);
export const FACILITY_ITEMS = EXPANDED_FACILITIES.map(([n]) => n);
export const SANITARY_BIN_REASON = '[Female] Sanitary bin is clean, intact and lined with plastic bag.';

/** Ticked checklist item -> feature (present when ticked, absent when not). Brief decision 3. */
export const TOILETRY_FEATURES: Record<string, FeatureName> = {
  'Toilet Paper': 'TOILET_PAPER',
  'Hand Towel': 'HAND_TOWEL',
  'Hand Dryer': 'HAND_DRYER',
  'Hand Soap': 'HAND_SOAP',
  'Toilet liner/Seat cleaner': 'SEAT_LINER',
};
/** "Taps/Urinals/Toilets/Door locks functional" and "Rubbish bin not full" are state, not features: skipped. */
export const FACILITY_FEATURES: Record<string, FeatureName> = {
  'Mirrors functional': 'MIRROR',
  'Bidet available': 'BIDET',
  'Functional automatic flush': 'AUTO_FLUSH',
  'Automatic tap': 'AUTO_TAP',
  'Automatic soap dispenser': 'AUTO_SOAP',
  'Feedback form or device available': 'FEEDBACK_DEVICE',
  'Ambulant facilities available (larger stalls with handrails)': 'AMBULANT',
  'Child facilities available': 'CHILD',
  'Nursing Room Available': 'NURSING_ROOM',
  'Handicapped Facilities Available': 'ACCESSIBLE',
};

/** A remark saying there is no sanitary bin ("No sanitary bin", "There does not appear to be a sanitary bin"). */
export const NO_SANITARY_BIN_RE = /\b(no|not|without)\b[^,.]*\bsanitary bins?\b/i;

// ───────────────────────────── row fields ─────────────────────────────

const SEX_MAP: Record<string, SurveySex> = { male: 'MALE', female: 'FEMALE', 'unisex (incl. handicapped)': 'UNISEX' };

export function parseSex(cell: string): SurveySex | null {
  return SEX_MAP[cell.replace(/\s+/g, ' ').trim().toLowerCase()] ?? null;
}

/** Sex -> the part of the toilet sourceKey. */
export const SEX_SLUG: Record<SurveySex, string> = { MALE: 'male', FEMALE: 'female', UNISEX: 'unisex' };
export const SEX_LABEL: Record<SurveySex, string> = { MALE: "Men's", FEMALE: "Women's", UNISEX: 'Accessible / unisex' };

/**
 * Google Forms timestamp as exported ("24/08/2024 09:15:35", the sheet's time zone, Singapore) ->
 * "2024-08-24T09:15:35+08:00". Null when it does not parse.
 */
export function parseTimestamp(cell: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(cell.trim());
  if (!m) return null;
  const [, d, mo, y, h, mi, s] = m;
  const p2 = (x: string | undefined) => (x ?? '0').padStart(2, '0');
  const iso = `${y}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(s)}+08:00`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

/** An integer cell within [min, max], else null. */
export function parseScale(cell: string, min: number, max: number): number | null {
  const n = Number(cell.trim());
  return cell.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** Drive "open?id=" / "file/d/<id>" link -> file id. */
export function driveFileId(url: string): string | null {
  const m = /[?&]id=([A-Za-z0-9_-]{10,})/.exec(url) ?? /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(url);
  return m ? m[1]! : null;
}

// ───────────────────────────── Location Codes ─────────────────────────────

export type Survey2VenueType = 'MRT_STATION' | 'MALL' | 'COFFEESHOP' | 'HAWKER_CENTRE' | 'BUS_INTERCHANGE';

/** Station code prefix -> the line code the pilot uses (CE is the Circle Line extension). */
export const STATION_PREFIX_LINES: Record<string, LineCode> = {
  NS: 'NSL',
  EW: 'EWL',
  NE: 'NEL',
  CC: 'CCL',
  CE: 'CCL',
  DT: 'DTL',
  TE: 'TEL',
};

/**
 * Tidy a raw Location Code ("M6." -> "M6", " ns22 " -> "NS22"). `fixed` says whether it changed
 * (other than whitespace), for review.json.
 */
export function cleanCode(raw: string): { code: string; fixed: boolean } {
  const trimmed = raw.trim().toUpperCase();
  const code = trimmed.replace(/[^A-Z0-9]/g, '');
  return { code, fixed: code !== trimmed };
}

/** Venue type from the code prefix; station prefixes first ("CC4" is the Circle Line, "C73" a coffeeshop). */
export function venueTypeOfCode(code: string): Survey2VenueType | null {
  const st = /^([A-Z]{2})\d+$/.exec(code);
  if (st && STATION_PREFIX_LINES[st[1]!]) return 'MRT_STATION';
  const m = /^([MCHB])\d+$/.exec(code);
  if (!m) return null;
  return ({ M: 'MALL', C: 'COFFEESHOP', H: 'HAWKER_CENTRE', B: 'BUS_INTERCHANGE' } as const)[m[1] as 'M' | 'C' | 'H' | 'B'];
}

/** "EW13" -> "EWL". */
export function lineOfStationCode(code: string): LineCode | null {
  const m = /^([A-Z]{2})\d+$/.exec(code);
  return m ? STATION_PREFIX_LINES[m[1]!] ?? null : null;
}

/** Station premise ("Outram Park NEL", "Promenade DTL / CCL", "Tanjong Rhu TEL ") -> name and lines. */
export function parseStationPremise(premise: string): { name: string; lines: LineCode[] } {
  const clean = premise.replace(/\s+/g, ' ').trim();
  const lines = splitLines(clean);
  const name = clean
    .replace(/\b(NSL|EWL|NEL|CCL|DTL|TEL)\b/gi, ' ')
    .replace(/[\s,/&]+$/g, '')
    .replace(/\s+[,/&]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { name, lines };
}

/** "S(670103)" (or a bare trailing 6-digit postcode) in an index address. */
export function postcodeOf(address: string): string | null {
  const m = /S\s*\(\s*(\d{6})\s*\)/i.exec(address) ?? /\bSingapore\s+(\d{6})\b/i.exec(address);
  return m ? m[1]! : null;
}

const SMALL_WORDS = new Set(['and', 'of', 'the', 'at', 'by']);
const KEEP_UPPER = new Set(['HDB', 'MRT', 'LRT', 'CC', 'NTUC', 'JEM', 'PLQ', 'AM', 'NEX', 'SAFRA', 'YMCA']);

/** "GANGSA ROAD" -> "Gangsa Road", "BUKIT BATOK STREET 31" -> "Bukit Batok Street 31". */
export function titleCaseWords(s: string): string {
  return s
    .toLowerCase()
    .split(/(\s+|-|\/)/)
    .map((w, i) => {
      if (!/[a-z]/.test(w)) return w;
      if (KEEP_UPPER.has(w.toUpperCase())) return w.toUpperCase();
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      return w[0]!.toUpperCase() + w.slice(1);
    })
    .join('');
}

export interface ParsedAddress {
  block: string | null;
  road: string | null;
  unit: string | null;
  /** Building / estate words after the unit ("INTERNATIONAL PLAZA"), title-cased. */
  building: string | null;
  postalCode: string | null;
}

/**
 * Coffeeshop index addresses: "103 GANGSA ROAD #01-35, S(670103)", "1018 SEMBAWANG ROAD, S(758495)",
 * "10 ANSON ROAD #01-21, INTERNATIONAL PLAZA S(079903)", "259 BUKIT PANJANG RING ROAD #01-36, BUKIT PANJANG NEW TOWN S(671259)".
 */
export function parseIndexAddress(address: string): ParsedAddress {
  const postalCode = postcodeOf(address);
  const body = address
    .replace(/S\s*\(\s*\d{6}\s*\)/i, ' ')
    .replace(/\bSingapore\b(\s+\d{6})?/i, ' ')
    .replace(/\bPart of\b.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/,$/, '')
    .trim();
  const [head = '', ...tail] = body.split(',').map((s) => s.trim());
  // Hawker centres: "Blk 79, Redhill Lane, S(150079)", "86, Market Street, CapitaSpring Building, S(048947)".
  const lone = /^(?:blks?\.?\s*)?(\d+[A-Z]?)$/i.exec(head);
  if (lone && tail[0]) {
    const unitT = /#\s*([0-9A-Z]{1,3}-[0-9A-Z]{1,5})/i.exec(tail.join(' '));
    const rest = tail
      .slice(1)
      .map((t) => t.replace(/#\s*[0-9A-Z]{1,3}-[0-9A-Z]{1,5}/i, '').trim())
      .filter(Boolean);
    return {
      block: lone[1]!.toUpperCase(),
      road: titleCaseWords(tail[0].replace(/#\s*[0-9A-Z]{1,3}-[0-9A-Z]{1,5}/i, '').trim()),
      unit: unitT ? `#${unitT[1]!.toUpperCase()}` : null,
      building: rest.length ? titleCaseWords(rest.join(', ')) : null,
      postalCode,
    };
  }
  const unitM = /#\s*([0-9A-Z]{1,3}-[0-9A-Z]{1,5})/i.exec(head);
  const beforeUnit = (unitM ? head.slice(0, unitM.index) : head).trim();
  const afterUnit = unitM ? head.slice(unitM.index + unitM[0].length).trim() : '';
  const bm = /^(?:blk\s*)?(\d+[A-Z]?)\s+(.+)$/i.exec(beforeUnit);
  const buildingRaw = [afterUnit, ...tail].filter(Boolean).join(', ').trim();
  return {
    block: bm ? bm[1]!.toUpperCase() : null,
    road: bm ? titleCaseWords(bm[2]!) : beforeUnit ? titleCaseWords(beforeUnit) : null,
    unit: unitM ? `#${unitM[1]!.toUpperCase()}` : null,
    building: buildingRaw ? titleCaseWords(buildingRaw) : null,
    postalCode,
  };
}

/** "103 Gangsa Road #01-35, Singapore 670103". */
export function tidyAddress(a: ParsedAddress): string | null {
  if (!a.road) return null;
  const street = [a.block, a.road, a.unit].filter(Boolean).join(' ');
  return [street, a.building, a.postalCode ? `Singapore ${a.postalCode}` : null].filter(Boolean).join(', ');
}

/**
 * Brief decision 9: address-only coffeeshops are "Coffeeshop, Blk 103 Gangsa Road". "Blk" is used when the
 * address has an HDB-style unit number (#01-35); a street address without one reads "Coffeeshop, 1018 Sembawang Road".
 */
export function coffeeshopName(a: ParsedAddress): string {
  if (!a.road) return 'Coffeeshop';
  const num = a.block ? (a.unit ? `Blk ${a.block} ` : `${a.block} `) : '';
  return `Coffeeshop, ${num}${a.road}`;
}

/**
 * Mall / hawker / interchange premise -> display name. "Compass Point (renamed Compass One)" -> "Compass One";
 * all-caps names are title-cased ("WOODLANDS CIVIC CENTRE" -> "Woodlands Civic Centre").
 */
export function premiseDisplayName(premise: string): string {
  let s = premise.replace(/\s+/g, ' ').trim();
  const renamed = /^(.*?)\s*\(\s*renamed\s+(.+?)\s*\)$/i.exec(s);
  if (renamed) s = renamed[2]!;
  if (s.length > 4 && !/[a-z]/.test(s)) s = titleCaseWords(s);
  return s;
}

/** Names a premise is also known by, for matching: "A / B", "A (B)", "renamed B". */
export function premiseAliases(premise: string): string[] {
  const s = premise.replace(/\s+/g, ' ').trim();
  const out = new Set<string>([s, premiseDisplayName(s)]);
  const paren = /^(.*?)\s*\((.+)\)\s*$/.exec(s);
  if (paren) {
    out.add(paren[1]!.trim());
    out.add(paren[2]!.replace(/^renamed\s+/i, '').trim());
  }
  for (const part of s.split(/\s+\/\s+|\s*\/\s*(?=[A-Z])/)) out.add(part.trim());
  return [...out].filter((x) => x.length > 1);
}

// ───────────────────────────── location within the premise ─────────────────────────────

export interface LocationParts {
  /** Normalised level ("L3", "B1") or null. */
  level: string | null;
  /** The text minus the level and premise name, tidied ("Near YGF Malatang"), or null. */
  note: string | null;
  /** Wing / lobby / tower / exit words for the label ("West Wing", "Lobby A", "Exit F"). */
  area: string | null;
}

const LEVEL_PATTERNS: RegExp[] = [
  // "Level 3", "Lvl 1", "level B1", "Floor 2", "lvl B2"
  /\b(?:level|lvl|lv|floor|storey)\s*\.?\s*(b?\s?\d{1,2})(?![\w-])/i,
  // "Basement 1", "Basement"
  /\bbasement\s*(\d{1,2})?(?![\w-])/i,
  // "L3", "b1", "B 2" (not "L4R", "#01-35", "Exit 5-7")
  /(?<![\w#-])([lb]\s?\d{1,2})(?![\w-])/i,
  // "Ground Level", "Ground floor", "ground"
  /\bground(?:\s*(?:level|floor))?\b(?!\s*(?:level\s*)?\d)/i,
];

const NOTE_FILLER = /^(?:near|next to|beside|opposite|toilets?|the|at|,|\s)*$/i;
/** A surveyor taking back an earlier answer: "(ignore previous response pls sorry)". Never shown as a note. */
export const RETRACTION_RE = /\bignore (?:the |my )?(?:previous|last|above) (?:response|entry|submission)\b/i;
/** The retraction with its brackets and trailing words ("(ignore previous response pls sorry)"). */
const RETRACTION_RE_PAREN = /\(?[^()]*\bignore (?:the |my )?(?:previous|last|above) (?:response|entry|submission)\b[^()]*\)?/i;
/** Free text without the retraction note; '' when that was all there was. */
export const stripRetraction = (text: string): string =>
  text
    .replace(RETRACTION_RE_PAREN, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;.]+|[\s,;]+$/g, '');
const WORD_NUMBERS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
/** Words that may trail a repeated premise name ("United square mall" at "United Square Shopping Mall"). */
const GENERIC_PREMISE_WORDS = new Set(['mall', 'shopping', 'centre', 'center']);

/**
 * Remove a leading repeat of the premise name ("Wisma Atria Basement 1 ...", "Hillion, Level 1, ...",
 * "United square mall, ..."). A single matching word counts only when no other word follows it
 * directly, so "Orchard Plaza" stays a note at "Orchard Point" and "Velocity square two" is kept.
 */
export function stripPremise(s: string, premiseNames: string[]): string {
  const tokens = s.match(/[^\s,]+|[\s,]+/g) ?? [];
  for (const name of [...premiseNames].sort((a, b) => b.length - a.length)) {
    const want = nameKey(name).split(' ').filter(Boolean);
    let matched = 0;
    let consumed = 0;
    let end = 0;
    for (const tok of tokens) {
      if (/^[\s,]+$/.test(tok)) {
        consumed += tok.length;
        continue;
      }
      const parts = nameKey(tok).split(' ').filter(Boolean);
      if (parts.length && matched + parts.length <= want.length && parts.every((p, i) => p === want[matched + i])) {
        matched += parts.length;
      } else if (!(matched && parts.length === 1 && GENERIC_PREMISE_WORDS.has(parts[0]!))) break;
      consumed += tok.length;
      end = consumed;
    }
    if (!matched) continue;
    const rest = s.slice(end);
    if (matched >= 2 || matched === want.length || !/^\s*[^\s,]/.test(rest)) return rest;
  }
  return s;
}

/**
 * Split the free-text "location within premise" cell ("Bukit Panjang Plaza, Level 2, next to Vivian and Sean")
 * into a level ("L2"), a note ("Next to Vivian and Sean") and label words.
 */
export function parseLocationText(text: string, premiseNames: string[] = []): LocationParts {
  let s = text
    .replace(/\s+/g, ' ')
    .replace(RETRACTION_RE_PAREN, ' ')
    .replace(/\b(level|lvl|floor)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (_, w: string, n: string) => `${w} ${WORD_NUMBERS[n.toLowerCase()]}`)
    .trim();
  if (!s) return { level: null, note: null, area: null };
  let level: string | null = null;
  for (const re of LEVEL_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    const token = m[0];
    if (/^basement/i.test(token)) level = `B${m[1] ?? '1'}`;
    else if (/^ground/i.test(token)) level = 'L1';
    else {
      const v = (m[1] ?? '').replace(/\s+/g, '').toUpperCase();
      level = v.startsWith('B') || v.startsWith('L') ? v : `L${v}`;
    }
    level = normalizeLevel(level);
    s = `${s.slice(0, m.index)} ${s.slice(m.index + token.length)}`;
    break;
  }
  // Drop the premise name when the text repeats it ("Wisma Atria Basement 1 near MANGO").
  s = stripPremise(s, premiseNames);
  s = s
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .replace(/^[\s,.;:-]+|[\s,;:-]+$/g, '')
    .replace(/,\s*,+/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^\(.*\)$/.test(s)) s = s.slice(1, -1).trim();
  const note = !s || NOTE_FILLER.test(s) ? null : s[0]!.toUpperCase() + s.slice(1);
  return { level, note, area: note ? areaWords(note) : null };
}

/** Wing / lobby / tower / exit words that tell two toilets of a venue apart. */
export function areaWords(note: string): string | null {
  const m =
    /\b(north|south|east|west|central)\s+wing\b/i.exec(note) ??
    /\b(?:wing|lobby|tower)\s+[a-z0-9]{1,2}\b/i.exec(note) ??
    /\bexit\s+[a-z]?\d{0,2}(?:\s*-\s*\d{1,2})?[a-z]?\b/i.exec(note);
  if (!m) return null;
  return titleCaseWords(m[0].replace(/\s*-\s*/g, '-')).replace(/\b([a-z])\b/g, (x) => x.toUpperCase());
}

/** Level -> the sourceKey part ("B1" -> "b1", "L3" -> "l3"). */
export const levelSlug = (level: string) => slugify(level);

/**
 * Toilet label: "Men's", "Women's", "Accessible / unisex", plus the line side at a multi-line station
 * ("Women's, NEL side") and wing/area words ("Men's, West Wing").
 */
export function toiletLabel(sex: SurveySex, opts: { lineSide?: string | null; area?: string | null } = {}): string {
  return [SEX_LABEL[sex], opts.lineSide ? `${opts.lineSide} side` : null, opts.area].filter(Boolean).join(', ');
}
