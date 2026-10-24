/**
 * `survey2:normalise`: data/raw/survey-2024b/{raw-data,location-index}.csv -> data/curated/fieldwork-2024b.json
 * (+ the `survey2` section of review.json). Pure and deterministic: the same CSVs give the same JSON.
 *
 * One toilet per (Location Code, sex); a location with several toilets of one sex (different floors /
 * wings) gets one toilet each, keyed by the normalised level, else by a stable ordinal (review.json).
 * Whether a venue is new or an existing one, and which men's rows are another survey of a pilot toilet,
 * is decided later by `survey2:match`.
 */
import {
  FEATURES,
  Fieldwork2024bSchema,
  loadRemarkOverrides,
  loadReview,
  type CuratedSurvey,
  type FeatureName,
  type Fieldwork2024b,
  type RemarkOverrides,
  type ReviewItem,
  type Survey2Remark,
  type Survey2Toilet,
  type Survey2Venue,
} from '../curated/schema.js';
import { writeJson } from '../lib/files.js';
import { paths } from '../lib/paths.js';
import { nameKey } from '../lib/slug.js';
import { INFERRED_HOURS, readCsv } from '../sheet/normalise.js';
import type { LineCode } from '../sheet/location.js';
import { normaliseExpandedCleanliness, type ExpandedBreakdown } from '../../toilets/survey-items.js';
import { SURVEY2_SHEET_ID, survey2TabPath } from './fetch.js';
import {
  FACILITY_FEATURES,
  FACILITY_ITEMS,
  NO_SANITARY_BIN_RE,
  REASON_ITEMS,
  SANITARY_BIN_REASON,
  SEX_SLUG,
  TOILETRY_FEATURES,
  TOILETRY_ITEMS,
  cleanCode,
  coffeeshopName,
  lineOfStationCode,
  levelSlug,
  parseIndexAddress,
  parseLocationText,
  parseScale,
  parseSex,
  parseStationPremise,
  parseTimestamp,
  premiseAliases,
  premiseDisplayName,
  splitChecklist,
  RETRACTION_RE,
  stripRetraction,
  tidyAddress,
  toiletLabel,
  venueTypeOfCode,
  type LocationParts,
  type Survey2VenueType,
} from './parse.js';
import type { SurveySex } from '../../generated/prisma/enums.js';

/** Raw Data columns (0-based), as laid out in the Google Form's response sheet. */
export const RAW_COLS = {
  timestamp: 0,
  sector: 1,
  sex: 2,
  code: 3,
  location: 4,
  cleanliness: 5,
  reasons: 6,
  scent: 7,
  toiletries: 8,
  facilities: 9,
  photo: 10,
} as const;
/** Short names for Survey.raw (the sheet's headers are whole sentences). */
const RAW_NAMES: Record<keyof typeof RAW_COLS, string> = {
  timestamp: 'Timestamp',
  sector: 'Sector',
  sex: 'Sex',
  code: 'Location Code',
  location: 'Location within premise',
  cleanliness: 'Cleanliness',
  reasons: 'Reasons',
  scent: 'Scent',
  toiletries: 'Toiletries',
  facilities: 'Facilities',
  photo: 'Photo',
};

export interface IndexEntry {
  code: string;
  address: string | null;
  premise: string | null;
  planningArea: string | null;
}

const cell = (r: string[], i: number) => (r[i] ?? '').replace(/\s+/g, ' ').trim();

export function readIndex(rows: string[][]): Map<string, IndexEntry> {
  const out = new Map<string, IndexEntry>();
  for (const r of rows.slice(1)) {
    const code = cleanCode(cell(r, 0)).code;
    if (!code) continue;
    out.set(code, { code, address: cell(r, 1) || null, premise: cell(r, 2) || null, planningArea: cell(r, 3) || null });
  }
  return out;
}

/** A retraction takes back a row of the same code and sex from the same team (Sector) at most this long before. */
export const RETRACTION_WINDOW_MIN = 15;

interface Row {
  rowIndex: number;
  ts: string;
  sector: string;
  /** Free text says "ignore previous response". */
  retraction: boolean;
  sex: SurveySex;
  code: string;
  location: string;
  loc: LocationParts;
  cleanliness: number;
  scent: number;
  reasons: string[];
  toiletries: string[];
  facilities: string[];
  remarks: string | null;
  photoUrl: string | null;
  raw: Record<string, string>;
}

export interface Survey2NormaliseResult {
  fieldwork: Fieldwork2024b;
  review: ReviewItem[];
  /** Every survey with a free-text remark (review.json `survey2Remarks`). */
  remarks: Survey2Remark[];
  stats: Record<string, unknown>;
}

const byCode = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

export function normaliseSurvey2(rawRows: string[][], indexRows: string[][], remarkOverrides: RemarkOverrides = {}): Survey2NormaliseResult {
  const review: ReviewItem[] = [];
  const index = readIndex(indexRows);
  const header = rawRows[0] ?? [];
  if (header.length < 11) throw new Error(`Raw Data has ${header.length} columns, expected 11`);

  // ── 1. Rows
  let rows: Row[] = [];
  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i]!;
    if (r.every((c) => !c.trim())) continue;
    const rowIndex = i + 1; // 1-based sheet row (row 1 is the header)
    const raw = Object.fromEntries(Object.entries(RAW_COLS).map(([k, j]) => [RAW_NAMES[k as keyof typeof RAW_COLS], cell(r, j)]));
    const skip = (why: string) =>
      review.push({ kind: 'survey2-row-skipped', key: `row ${rowIndex}`, message: `Raw Data row ${rowIndex}: ${why}`, resolution: 'auto: row not imported', data: raw });
    const ts = parseTimestamp(cell(r, RAW_COLS.timestamp));
    const sex = parseSex(cell(r, RAW_COLS.sex));
    const { code, fixed } = cleanCode(cell(r, RAW_COLS.code));
    const cleanliness = parseScale(cell(r, RAW_COLS.cleanliness), -3, 3);
    const scent = parseScale(cell(r, RAW_COLS.scent), -2, 2);
    if (!ts) {
      skip(`timestamp "${cell(r, RAW_COLS.timestamp)}" does not parse`);
      continue;
    }
    if (!sex) {
      skip(`sex "${cell(r, RAW_COLS.sex)}" is not Male / Female / Unisex (incl. Handicapped)`);
      continue;
    }
    if (!index.has(code) || !venueTypeOfCode(code)) {
      skip(`Location Code "${cell(r, RAW_COLS.code)}" is not in the Location Code Index`);
      continue;
    }
    if (cleanliness === null || scent === null) {
      skip(`cleanliness "${cell(r, RAW_COLS.cleanliness)}" / scent "${cell(r, RAW_COLS.scent)}" out of range`);
      continue;
    }
    if (fixed)
      review.push({
        kind: 'survey2-code-fixed',
        key: code,
        message: `Raw Data row ${rowIndex}: Location Code "${cell(r, RAW_COLS.code)}" read as "${code}"`,
        resolution: 'auto: typo fixed (stray punctuation)',
      });

    const reasons = splitChecklist(cell(r, RAW_COLS.reasons), REASON_ITEMS);
    const toiletries = splitChecklist(cell(r, RAW_COLS.toiletries), TOILETRY_ITEMS);
    const facilities = splitChecklist(cell(r, RAW_COLS.facilities), FACILITY_ITEMS);
    for (const [name, sp] of [
      ['Toiletries', toiletries],
      ['Facilities', facilities],
    ] as const) {
      if (sp.rest)
        review.push({
          kind: 'survey2-checklist-leftover',
          key: code,
          message: `Raw Data row ${rowIndex}: ${name} has text that is not a checklist item: "${sp.rest}"`,
          resolution: 'auto: kept in Survey.remarks',
        });
      if (sp.none && sp.items.length)
        review.push({
          kind: 'survey2-none-and-items',
          key: code,
          message: `Raw Data row ${rowIndex}: ${name} ticks "None of the Above" and ${sp.items.length} item(s)`,
          resolution: 'auto: the ticked items are imported',
        });
    }
    const location = cell(r, RAW_COLS.location);
    const retraction = [location, reasons.rest, toiletries.rest, facilities.rest].some((x) => RETRACTION_RE.test(x ?? ''));
    // The retraction note is handled below (dropRetracted) and never shown.
    const rest = (x: string | null) => (x && retraction ? stripRetraction(x) : x);
    const remarks = [rest(reasons.rest), rest(toiletries.rest) && `Toiletries: ${rest(toiletries.rest)}`, rest(facilities.rest) && `Facilities: ${rest(facilities.rest)}`]
      .filter(Boolean)
      .join('; ');
    const entry = index.get(code)!;
    const photo = cell(r, RAW_COLS.photo);
    rows.push({
      rowIndex,
      ts,
      sector: cell(r, RAW_COLS.sector),
      retraction,
      sex,
      code,
      location,
      loc: parseLocationText(location, entry.premise ? premiseAliases(entry.premise) : []),
      cleanliness,
      scent,
      reasons: reasons.items,
      toiletries: toiletries.items,
      facilities: facilities.items,
      remarks: remarks || null,
      photoUrl: /^https?:\/\//.test(photo) ? photo : null,
      raw: { _tab: 'Raw Data', _row: String(rowIndex), ...raw },
    });
  }

  rows = dropRetracted(rows, review);

  // ── 2. Venues: one per Location Code used in Raw Data
  const stationLines = stationLinesByName(index);
  const codes = [...new Set(rows.map((r) => r.code))].sort(byCode);
  const venues: Survey2Venue[] = [];
  const venueByCode = new Map<string, Survey2Venue>();
  for (const code of codes) {
    const v = buildVenue(index.get(code)!, venueTypeOfCode(code)!, stationLines);
    venues.push(v);
    venueByCode.set(code, v);
  }
  disambiguateNames(venues, review);
  for (const v of venues)
    if (v.type === 'MALL' && /\b(library|gardens?|park|ikea|civic|tower)\b/i.test(v.name))
      review.push({
        kind: 'survey2-type-check',
        key: v.code,
        message: `${v.code} "${v.name}" has an M (mall) code but the name suggests another kind of place`,
        resolution: 'auto: imported as MALL (the type comes from the code prefix); change Venue.type by hand if wrong',
      });

  // ── 3. Toilets: one per (code, sex); several of one sex split by level, else ordinal
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.code}/${SEX_SLUG[r.sex]}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const toilets: Survey2Toilet[] = [];
  for (const [base, group] of [...groups].sort(([a], [b]) => byCode(a, b))) {
    group.sort((a, b) => a.ts.localeCompare(b.ts) || a.rowIndex - b.rowIndex);
    const suffixes = toiletSuffixes(group);
    if (suffixes.some((s) => s !== null && !/^[lbm]\d*$|^[lbm]\d+(?:-[lbm]\d+)*$/.test(s)))
      review.push({
        kind: 'survey2-same-sex-ordinal',
        key: `survey2:${base}`,
        message: `${group.length} ${SEX_SLUG[group[0]!.sex]} rows at ${base.split('/')[0]} (${venueByCode.get(group[0]!.code)!.name}) that the level does not tell apart: ${group
          .map((r, i) => `${suffixes[i]} = row ${r.rowIndex} ${r.ts.slice(0, 16)} "${r.location || '(no location given)'}"`)
          .join('; ')}`,
        resolution: 'auto: one toilet each, numbered by survey time. Merge or rename by hand if two rows are the same toilet.',
      });
    group.forEach((r, i) => {
      const suffix = suffixes[i];
      toilets.push(buildToilet(r, suffix ? `survey2:${base}/${suffix}` : `survey2:${base}`, venueByCode.get(r.code)!, index.get(r.code)!));
    });
  }
  toilets.sort((a, b) => byCode(a.sourceKey, b.sourceKey));
  const seen = new Set<string>();
  for (const t of toilets) {
    if (seen.has(t.sourceKey)) throw new Error(`Duplicate survey2 toilet sourceKey ${t.sourceKey}`);
    seen.add(t.sourceKey);
  }

  const remarks = applyRemarkOverrides(toilets, venueByCode, remarkOverrides, review);

  const dates = rows.map((r) => r.ts.slice(0, 10)).sort();
  const fieldwork = Fieldwork2024bSchema.parse({
    source: {
      sheetId: SURVEY2_SHEET_ID,
      observedFrom: dates[0] ?? '2024-08-24',
      observedTo: dates[dates.length - 1] ?? '2024-10-14',
      note: 'Expanded toilet survey by u/eggmayosandwich and team, Aug-Oct 2024. Generated by `pnpm cli survey2:normalise` from data/raw/survey-2024b/*.csv; do not edit by hand (use survey2-venue-matches.json / overrides.json).',
    },
    venues,
    toilets,
  });

  const count = <T>(xs: T[], f: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
  const stats = {
    rows: rawRows.length - 1,
    surveys: rows.length,
    locations: venues.length,
    venuesByType: count(venues, (v) => v.type),
    toilets: toilets.length,
    toiletsBySex: count(toilets, (t) => t.sex),
    surveysBySex: count(rows, (r) => r.sex),
    locationsWithSeveralOfOneSex: new Set([...groups].filter(([, g]) => g.length > 1).map(([k]) => k.split('/')[0])).size,
    photoUrls: rows.filter((r) => r.photoUrl).length,
    withLevel: toilets.filter((t) => t.level).length,
    reviewItems: count(review, (x) => x.kind),
    remarks: remarks.length,
    remarksOverridden: remarks.filter((x) => x.original !== undefined).length,
  };
  return { fieldwork, review, remarks, stats };
}

/**
 * "(ignore previous response pls sorry)": the row takes back the one before it. That row is dropped when
 * it is clear which one is meant: the only earlier row of the same code and sex from the same team
 * (Sector) within RETRACTION_WINDOW_MIN. Otherwise every row is kept and review.json says so.
 */
export function dropRetracted<R extends Pick<Row, 'rowIndex' | 'ts' | 'sector' | 'retraction' | 'sex' | 'code' | 'location'>>(
  rows: R[],
  review: ReviewItem[],
): R[] {
  const dropped = new Set<R>();
  const at = (r: R) => Date.parse(r.ts);
  for (const r of rows) {
    if (!r.retraction) continue;
    const session = rows.filter(
      (o) =>
        o !== r &&
        !o.retraction &&
        !dropped.has(o) &&
        o.code === r.code &&
        o.sex === r.sex &&
        o.sector === r.sector &&
        at(o) <= at(r) &&
        at(r) - at(o) <= RETRACTION_WINDOW_MIN * 60_000,
    );
    const what = `Raw Data row ${r.rowIndex} (${r.code} ${r.sex}, ${r.sector}, ${r.ts.slice(0, 16)}) says "${r.location}"`;
    if (session.length === 1) {
      const p = session[0]!;
      dropped.add(p);
      review.push({
        kind: 'survey2-retraction',
        key: r.code,
        message: `${what}: it takes back row ${p.rowIndex} (${p.sex}, ${p.ts.slice(11, 16)})`,
        resolution: `auto: row ${p.rowIndex} not imported; row ${r.rowIndex} imported without the note`,
      });
      continue;
    }
    const earlier = rows
      .filter((o) => o.code === r.code && o.ts < r.ts)
      .map((o) => `row ${o.rowIndex} ${o.sex} ${o.sector} ${o.ts.slice(11, 16)}`)
      .join(', ');
    review.push({
      kind: 'survey2-retraction',
      key: r.code,
      message: `${what}. ${session.length ? `${session.length} earlier ${r.sex} rows` : `No earlier ${r.sex} row`} from that team within ${RETRACTION_WINDOW_MIN} min. Earlier rows at ${r.code}: ${earlier || 'none'}`,
      resolution: 'auto: every row imported (it is not clear which earlier row is meant); the note is not shown. Drop the wrong row by hand.',
    });
  }
  return rows.filter((r) => !dropped.has(r));
}

/** overrides.json `remarkOverrides` onto the surveys, and the list of every remark for review.json. */
function applyRemarkOverrides(
  toilets: Survey2Toilet[],
  venueByCode: Map<string, Survey2Venue>,
  overrides: RemarkOverrides,
  review: ReviewItem[],
): Survey2Remark[] {
  const out: Survey2Remark[] = [];
  const used = new Set<string>();
  for (const t of toilets)
    for (const s of t.surveys) {
      const original = s.remarks;
      if (Object.hasOwn(overrides, s.key)) {
        used.add(s.key);
        s.remarks = overrides[s.key]?.trim() || null;
      }
      if (!original && !s.remarks) continue;
      out.push({
        key: s.key,
        toilet: t.sourceKey,
        venue: venueByCode.get(t.code)!.name,
        sex: t.sex,
        remark: s.remarks,
        ...(s.remarks !== original ? { original: original ?? '' } : {}),
      });
    }
  for (const k of Object.keys(overrides).filter((x) => !used.has(x)).sort())
    review.push({ kind: 'survey2-remark-override-orphan', key: k, message: `overrides.json remarkOverrides has "${k}" but no such survey`, resolution: 'auto: ignored' });
  return out;
}

/** Station name key -> every line any index code of that station is on ("City Hall" -> NSL, EWL). */
function stationLinesByName(index: Map<string, IndexEntry>): Map<string, LineCode[]> {
  const out = new Map<string, LineCode[]>();
  for (const e of index.values()) {
    if (venueTypeOfCode(e.code) !== 'MRT_STATION' || !e.premise) continue;
    const p = parseStationPremise(e.premise);
    const k = nameKey(p.name);
    const lines = out.get(k) ?? [];
    for (const l of [lineOfStationCode(e.code), ...p.lines]) if (l && !lines.includes(l)) lines.push(l);
    out.set(k, lines);
  }
  for (const lines of out.values()) lines.sort();
  return out;
}

function buildVenue(e: IndexEntry, type: Survey2VenueType, stationLines: Map<string, LineCode[]>): Survey2Venue {
  const base = {
    key: e.code,
    sourceKey: `survey2-venue:${e.code}`,
    code: e.code,
    type,
    toiletStatus: 'HAS_TOILETS' as const,
    note: null,
    openingHours: INFERRED_HOURS[type],
    usesNearbyVenueKey: null,
    premise: e.premise,
    indexAddress: e.address,
  };
  const addr = e.address ? parseIndexAddress(e.address) : null;
  const postal = addr?.postalCode ?? null;
  // Mall / interchange addresses in the index are "1 SENGKANG SQUARE Singapore": a usable fallback query.
  const streetQuery = e.address
    ? e.address
        .replace(/\bSingapore\b.*$/i, '')
        .replace(/,?\s*S\(\d{6}\)/i, '')
        .replace(/\bPart of\b.*$/i, '')
        .replace(/[\s,]+$/, '')
        .trim()
    : '';
  switch (type) {
    case 'MRT_STATION': {
      const p = parseStationPremise(e.premise ?? e.code);
      const lines = stationLines.get(nameKey(p.name)) ?? [...new Set([lineOfStationCode(e.code), ...p.lines].filter((l): l is LineCode => !!l))];
      return { ...base, name: p.name, lines, address: null, postalCode: null, geocode: { strategy: 'mrt', query: `${p.name} MRT STATION` } };
    }
    case 'COFFEESHOP': {
      const name = e.premise ? premiseDisplayName(e.premise) : addr ? coffeeshopName(addr) : 'Coffeeshop';
      return {
        ...base,
        name,
        lines: [],
        address: addr ? tidyAddress(addr) : null,
        postalCode: postal,
        geocode: postal ? { strategy: 'postal', query: postal, fallbackQuery: streetQuery || undefined } : { strategy: 'place', query: streetQuery || name },
      };
    }
    case 'HAWKER_CENTRE': {
      const name = premiseDisplayName(e.premise ?? (addr ? tidyAddress(addr) ?? e.code : e.code));
      return {
        ...base,
        name,
        lines: [],
        address: addr ? tidyAddress(addr) : null,
        postalCode: postal,
        geocode: postal ? { strategy: 'postal', query: postal, fallbackQuery: name } : { strategy: 'place', query: name },
      };
    }
    default: {
      const name = premiseDisplayName(e.premise ?? e.code);
      return {
        ...base,
        name,
        lines: [],
        address: postal && addr ? tidyAddress(addr) : null,
        postalCode: postal,
        geocode: { strategy: 'place', query: name, ...(streetQuery && streetQuery !== name ? { fallbackQuery: streetQuery } : {}) },
      };
    }
  }
}

/** Several coffeeshops in one block share a name: add the unit ("Coffeeshop, Blk 101 Yishun Avenue 5 (#01-93)"). */
function disambiguateNames(venues: Survey2Venue[], review: ReviewItem[]): void {
  const byName = new Map<string, Survey2Venue[]>();
  // Stations are exempt: several codes of one station ("Outram Park" NE3 / TE17) are the same place.
  for (const v of venues.filter((x) => x.type !== 'MRT_STATION'))
    byName.set(`${v.type}|${v.name}`, [...(byName.get(`${v.type}|${v.name}`) ?? []), v]);
  for (const [, same] of byName) {
    if (same.length < 2) continue;
    for (const v of same) {
      const unit = v.indexAddress ? parseIndexAddress(v.indexAddress).unit : null;
      v.name = `${v.name} (${unit ?? v.code})`;
    }
    review.push({
      kind: 'survey2-name-collision',
      key: same.map((v) => v.code).join(','),
      message: `${same.length} venues would be called "${same[0]!.name.replace(/ \(.*\)$/, '')}": ${same.map((v) => `${v.code} -> "${v.name}"`).join('; ')}`,
      resolution: 'auto: unit number (or code) added to each name',
    });
  }
}

/**
 * The part after `survey2:<CODE>/<sex>` for each row of one (code, sex) group, in group order:
 * null for a lone row; the level slug when that level is unique in the group ("l3"); otherwise an
 * ordinal by survey time, after the level when there is one ("b1-2") or alone ("2").
 */
export function toiletSuffixes(group: { loc: { level: string | null } }[]): (string | null)[] {
  if (group.length === 1) return [null];
  const levelCount = new Map<string, number>();
  for (const r of group) if (r.loc.level) levelCount.set(r.loc.level, (levelCount.get(r.loc.level) ?? 0) + 1);
  const seen = new Map<string, number>();
  return group.map((r) => {
    const lv = r.loc.level;
    if (lv && levelCount.get(lv) === 1) return levelSlug(lv);
    const k = lv ?? '';
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return lv ? `${levelSlug(lv)}-${n}` : String(n);
  });
}

function buildToilet(r: Row, sourceKey: string, v: Survey2Venue, e: IndexEntry): Survey2Toilet {
  const features = new Map<FeatureName, boolean>();
  for (const [item, f] of Object.entries(TOILETRY_FEATURES)) features.set(f, r.toiletries.includes(item));
  for (const [item, f] of Object.entries(FACILITY_FEATURES)) features.set(f, r.facilities.includes(item));
  // Sanitary bin: ticking the [Female] reason says there is one; not ticking it may only mean it was dirty,
  // so absence is recorded only when a women's row says so in words.
  if (r.reasons.includes(SANITARY_BIN_REASON)) features.set('SANITARY_BIN', true);
  else if (r.sex === 'FEMALE' && r.remarks && NO_SANITARY_BIN_RE.test(r.remarks)) features.set('SANITARY_BIN', false);
  features.set('MALE', r.sex === 'MALE');
  features.set('FEMALE', r.sex === 'FEMALE');
  features.set('UNISEX', r.sex === 'UNISEX');

  let toiletLines: LineCode[] = [];
  let lineSide: string | null = null;
  if (v.type === 'MRT_STATION') {
    const p = parseStationPremise(e.premise ?? '');
    const own = lineOfStationCode(r.code);
    toiletLines = p.lines.length ? p.lines : own ? [own] : [];
    if (v.lines.some((l) => !toiletLines.includes(l as LineCode))) lineSide = toiletLines.join('/');
  }

  const breakdown: ExpandedBreakdown = {
    cleanliness: r.cleanliness,
    scent: r.scent,
    reasons: r.reasons,
    toiletries: r.toiletries,
    facilities: r.facilities,
  };
  const survey: CuratedSurvey = {
    key: `${sourceKey}#${r.ts}`,
    surveyedAt: r.ts,
    rubric: 'EXPANDED_2024',
    sex: r.sex,
    phase: null,
    cleanliness: normaliseExpandedCleanliness(r.cleanliness),
    scent: null,
    aesthetics: null,
    music: null,
    toiletries: null,
    facilities: null,
    total: null,
    rasStars: null,
    remarks: r.remarks,
    breakdown,
    raw: r.raw,
  };
  return {
    sourceKey,
    venueKey: v.key,
    code: r.code,
    sex: r.sex,
    location: r.location,
    label: toiletLabel(r.sex, { lineSide, area: r.loc.area }),
    level: r.loc.level,
    accessNote: r.loc.note,
    lines: toiletLines,
    status: 'ACTIVE',
    tier: 'VERIFIED',
    areaType: 'UNKNOWN',
    lastVerifiedAt: r.ts,
    needsResurvey: false,
    features: FEATURES.filter((f) => features.has(f)).map((f) => ({ feature: f, present: features.get(f)! })),
    surveys: [survey],
    photoUrl: r.photoUrl,
  };
}

export function runSurvey2Normalise(): { log: Record<string, unknown> } {
  const { fieldwork, review, remarks, stats } = normaliseSurvey2(
    readCsv(survey2TabPath('raw-data.csv')),
    readCsv(survey2TabPath('location-index.csv')),
    loadRemarkOverrides(),
  );
  writeJson(paths.fieldwork2024b, fieldwork);
  writeJson(paths.review, { ...loadReview(), survey2: review, survey2Remarks: remarks });
  console.log('  wrote data/curated/fieldwork-2024b.json');
  console.log(`  ${review.length} review item(s) -> data/curated/review.json (survey2 section)`);
  console.log(`  ${remarks.length} survey remark(s) -> data/curated/review.json (survey2Remarks section)`);
  console.log(JSON.stringify(stats, null, 2));
  return { log: stats };
}
