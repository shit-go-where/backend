import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import {
  FEATURES,
  FieldworkSchema,
  loadReview,
  type CuratedSurvey,
  type CuratedToilet,
  type CuratedVenue,
  type FeatureName,
  type Fieldwork,
  type OpeningHours,
  type ReviewItem,
} from '../curated/schema.js';
import { writeJson } from '../lib/files.js';
import { paths } from '../lib/paths.js';
import { nameKey } from '../lib/slug.js';
import { SHEET_ID, sheetTabPath } from './fetch.js';
import {
  displayName,
  geocodeQueryFor,
  isSheetTypeCode,
  parseLocation,
  SHEET_TYPE_MAP,
  toiletLabel,
  toiletSourceKey,
  venueKeyFor,
  type CuratedVenueType,
  type ParsedLocation,
} from './location.js';

export const FIELDWORK_DATE = '2024-03-15';
export const PRE_RENEWAL_DATE = '2024-03-14';

export const TOILETRIES_COLS = [
  'Toilet Paper (1)',
  'Hand Towel (1)',
  'Hand Dryer (1)',
  'Hand Soap (1)',
  'Toilet Liner (1)',
] as const;
export const FACILITY_COLS = [
  'Mirror (2)',
  'Taps (2)',
  'Urinals (2)',
  'Toilets (2)',
  'Door Locks (1)',
  'Coat Hooks (1)',
  'Bidet (1)',
  'Auto Flush (1)',
  'Auto Tap (1)',
  'Auto Soap (1)',
  'Bin not full (1)',
  'Feedback (1)',
  'Ambulant Facilities (1)',
  'Child Facilities (1)',
  'Signages (1)',
  'Posters (1)',
] as const;
/** Boolean rubric columns that become ToiletFeature rows (present = value > 0). */
export const FEATURE_COLS: Record<string, FeatureName> = {
  'Toilet Paper (1)': 'TOILET_PAPER',
  'Hand Towel (1)': 'HAND_TOWEL',
  'Hand Dryer (1)': 'HAND_DRYER',
  'Hand Soap (1)': 'HAND_SOAP',
  'Toilet Liner (1)': 'SEAT_LINER',
  'Coat Hooks (1)': 'COAT_HOOK',
  'Bidet (1)': 'BIDET',
  'Auto Flush (1)': 'AUTO_FLUSH',
  'Auto Tap (1)': 'AUTO_TAP',
  'Auto Soap (1)': 'AUTO_SOAP',
  'Feedback (1)': 'FEEDBACK_DEVICE',
  'Ambulant Facilities (1)': 'AMBULANT',
  'Child Facilities (1)': 'CHILD',
  'Signages (1)': 'SIGNAGE',
  'Posters (1)': 'POSTERS',
};

const MRT_HOURS: OpeningHours = {
  type: 'weekly',
  periods: [
    { days: [1, 2, 3, 4, 5, 6], open: '05:30', close: '00:30' },
    { days: [0], open: '06:00', close: '00:30' },
  ],
  inferred: true,
};
const daily = (open: string, close: string): OpeningHours => ({
  type: 'weekly',
  periods: [{ days: [0, 1, 2, 3, 4, 5, 6], open, close }],
  inferred: true,
});
export const INFERRED_HOURS: Record<CuratedVenueType, OpeningHours> = {
  MRT_STATION: MRT_HOURS,
  BUS_INTERCHANGE: MRT_HOURS,
  MALL: daily('10:00', '22:00'),
  HAWKER_CENTRE: daily('06:00', '22:00'),
  COFFEESHOP: daily('06:00', '23:00'),
  COMMUNITY_CLUB: daily('09:00', '22:00'),
};

const HANDICAPPED_ONLY_RE = /no\s*m\s*\/\s*f\s*toilet.*only\s*1\s*handic/i;

// ───────────────────────────── CSV table helpers ─────────────────────────────

export function readCsv(file: string): string[][] {
  return parse(fs.readFileSync(file, 'utf8'), { relax_column_count: true, skip_empty_lines: false }) as string[][];
}

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export interface TableRecord {
  rowIndex: number;
  section: string | null;
  cells: Record<string, string>;
  get(col: string): string;
}

/**
 * Walk a tab and return every data row (col 0 is a type code) with column names taken from the
 * nearest two-row header above it ("Type, Location, ..." + sub-columns), plus the most recent
 * section heading ("RAS 4-Star", "Pre-Renewal", ...). Summary rows (Mean Values, Range, averages)
 * and blank rows are skipped.
 */
export function readScoreTable(rows: string[][]): TableRecord[] {
  let header: string[] | null = null;
  let section: string | null = null;
  const out: TableRecord[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const c0 = clean(r[0]);
    if (c0 === 'Type' && clean(r[1]) === 'Location') {
      const sub = rows[i + 1] ?? [];
      header = r.map((top, j) => clean(sub[j]) || clean(top));
      i++;
      continue;
    }
    if (c0 && r.slice(1).every((c) => !clean(c))) {
      section = c0;
      continue;
    }
    if (!header || !isSheetTypeCode(c0)) continue;
    const cells: Record<string, string> = {};
    header.forEach((h, j) => {
      if (h) cells[h] = clean(r[j]);
    });
    out.push({ rowIndex: i + 1, section, cells, get: (col) => cells[col] ?? '' });
  }
  return out;
}

const num = (s: string): number | null => {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// ───────────────────────────── normalise ─────────────────────────────

interface ToiletDraft {
  sourceKey: string;
  venueKey: string;
  type: CuratedVenueType;
  parsed: ParsedLocation;
  status: 'ACTIVE' | 'RENOVATION';
  needsResurvey: boolean;
  features: Map<FeatureName, boolean>;
  surveys: CuratedSurvey[];
}

interface VenueDraft {
  key: string;
  name: string;
  type: CuratedVenueType;
  lines: string[];
  notes: string[];
  rawName: string;
  forcedStatus: 'USES_NEARBY' | 'NONE' | null;
  usesNearbyNote: string | null;
}

export interface NormaliseResult {
  fieldwork: Fieldwork;
  review: ReviewItem[];
  stats: Record<string, unknown>;
}

function surveyFromRecord(
  rec: TableRecord,
  toiletKey: string,
  surveyedAt: string,
  phase: string | null,
  tab: string,
  review: ReviewItem[],
): CuratedSurvey {
  const int = (col: string) => {
    const v = num(rec.get(col));
    if (v === null) {
      review.push({
        kind: 'blank-cell',
        key: toiletKey,
        message: `${tab} row ${rec.rowIndex}: "${col}" is blank; counted as 0 in the survey, feature left unset`,
        resolution: 'auto: treated as 0 / unknown',
      });
      return 0;
    }
    return Math.round(v);
  };
  const toiletries = TOILETRIES_COLS.reduce((s, c) => s + int(c), 0);
  const facilities = FACILITY_COLS.reduce((s, c) => s + int(c), 0);
  const s = {
    cleanliness: int('Cleanliness (10)'),
    scent: int('Scent (5)'),
    aesthetics: int('Aesthetics (5)'),
    music: int('Music (5)'),
  };
  const total = int('Total (50)');
  const computed = s.cleanliness + s.scent + s.aesthetics + s.music + toiletries + facilities;
  if (computed !== total) {
    review.push({
      kind: 'total-mismatch',
      key: toiletKey,
      message: `${tab} row ${rec.rowIndex} (${rec.get('Location')}): sheet Total (50) = ${total}, components sum to ${computed}`,
      resolution: 'auto: kept the sheet total; components imported as recorded',
    });
  }
  const remarks = rec.get('Other Remarks') || null;
  return {
    key: `${toiletKey}#${phase ?? 'general'}#${surveyedAt}`,
    surveyedAt,
    phase,
    ...s,
    toiletries,
    facilities,
    total,
    rasStars: null,
    remarks,
    raw: { _tab: tab, _row: rec.rowIndex, ...rec.cells },
  };
}

const COMPARE_COLS = [
  'Total (50)',
  'Cleanliness (10)',
  'Scent (5)',
  'Aesthetics (5)',
  'Music (5)',
  ...TOILETRIES_COLS,
  ...FACILITY_COLS,
];

export function normaliseSheet(): NormaliseResult {
  const review: ReviewItem[] = [];
  const general = readScoreTable(readCsv(sheetTabPath('general-data.csv')));
  const ras = readScoreTable(readCsv(sheetTabPath('ras-ratings.csv')));
  const renewalRows = readCsv(sheetTabPath('toilet-renewal.csv'));
  const renewal = readScoreTable(renewalRows);
  const miscRows = readCsv(sheetTabPath('miscellaneous.csv'));

  const venues = new Map<string, VenueDraft>();
  const toilets = new Map<string, ToiletDraft>();

  const ensureVenue = (parsed: ParsedLocation, type: CuratedVenueType): VenueDraft => {
    const key = venueKeyFor(parsed.name, type);
    let v = venues.get(key);
    if (!v) {
      v = { key, rawName: parsed.name, name: displayName(parsed.name, type), type, lines: [], notes: [], forcedStatus: null, usesNearbyNote: null };
      venues.set(key, v);
    }
    for (const l of parsed.lines) if (!v.lines.includes(l)) v.lines.push(l);
    return v;
  };

  // 1. General Data: one toilet per row.
  for (const rec of general) {
    const code = rec.get('Type');
    if (!isSheetTypeCode(code)) continue;
    const type = SHEET_TYPE_MAP[code];
    const parsed = parseLocation(rec.get('Location'));
    const venue = ensureVenue(parsed, type);
    const sourceKey = toiletSourceKey(parsed.original);
    if (toilets.has(sourceKey)) {
      review.push({ kind: 'duplicate-location', key: sourceKey, message: `General Data row ${rec.rowIndex} duplicates ${parsed.original}`, resolution: 'auto: later row ignored' });
      continue;
    }
    const features = new Map<FeatureName, boolean>();
    for (const [col, feature] of Object.entries(FEATURE_COLS)) {
      const v = num(rec.get(col));
      if (v !== null) features.set(feature, v > 0);
    }
    features.set('FREE', true);
    if (type === 'MRT_STATION' || type === 'MALL' || type === 'BUS_INTERCHANGE') features.set('SITTING', true);
    const survey = surveyFromRecord(rec, sourceKey, FIELDWORK_DATE, null, 'General Data', review);
    if (survey.remarks && HANDICAPPED_ONLY_RE.test(survey.remarks)) applyHandicappedOnly(features);
    toilets.set(sourceKey, {
      sourceKey,
      venueKey: venue.key,
      type,
      parsed,
      status: 'ACTIVE',
      needsResurvey: false,
      features,
      surveys: [survey],
    });
  }
  const generalCount = toilets.size;

  // 2. RAS Ratings: star per location, plus a cross-check of the scores.
  let rasRated = 0;
  let rasBlank = 0;
  const rasSeen = new Set<string>();
  for (const rec of ras) {
    const sourceKey = toiletSourceKey(parseLocation(rec.get('Location')).original);
    const t = toilets.get(sourceKey);
    if (!t) {
      review.push({ kind: 'ras-unmatched', key: sourceKey, message: `RAS Ratings row ${rec.rowIndex} "${rec.get('Location')}" has no General Data row`, resolution: 'auto: ignored' });
      continue;
    }
    rasSeen.add(sourceKey);
    const main = t.surveys[0]!;
    const starsRaw = rec.get('RAS Stars (5)');
    const stars = num(starsRaw);
    if (stars === null) rasBlank++;
    else if (Number.isInteger(stars) && stars >= 1 && stars <= 5) {
      main.rasStars = stars;
      rasRated++;
    } else {
      review.push({
        kind: 'ras-out-of-range',
        key: sourceKey,
        message: `RAS Ratings row ${rec.rowIndex} (${rec.get('Location')}, section "${rec.section}") has RAS Stars = ${starsRaw}; the scale is 1-5`,
        resolution: 'auto: rasStars left null; value kept in Survey.raw["RAS Stars (5)"]. Confirm with RAS before setting.',
      });
    }
    main.raw['RAS Stars (5)'] = starsRaw;
    main.raw['_rasSection'] = rec.section;
    const diffs: Record<string, { general: string; ras: string }> = {};
    for (const col of COMPARE_COLS) {
      const g = String(main.raw[col] ?? '');
      const r = rec.get(col);
      if (num(g) !== num(r)) diffs[col] = { general: g, ras: r };
    }
    if (!main.remarks && rec.get('Other Remarks')) main.remarks = rec.get('Other Remarks');
    if (Object.keys(diffs).length) {
      main.raw['_rasTabDiffs'] = diffs;
      review.push({
        kind: 'ras-tab-differs',
        key: sourceKey,
        message: `RAS Ratings row ${rec.rowIndex} (${rec.get('Location')}) disagrees with General Data on ${Object.keys(diffs).join(', ')}`,
        resolution: 'auto: General Data values imported; RAS-tab values kept in Survey.raw._rasTabDiffs',
        data: diffs,
      });
    }
  }
  for (const k of toilets.keys())
    if (!rasSeen.has(k))
      review.push({ kind: 'ras-missing', key: k, message: `${k} is not listed in RAS Ratings`, resolution: 'auto: rasStars null' });

  // 3. Toilet Renewal: pre-renewal surveys, post-renewal phase, under-renewal stations.
  let preRenewal = 0;
  let postRenewal = 0;
  for (const rec of renewal) {
    const sourceKey = toiletSourceKey(parseLocation(rec.get('Location')).original);
    const t = toilets.get(sourceKey);
    const phase = /^pre/i.test(rec.section ?? '') ? 'pre-renewal' : /^post/i.test(rec.section ?? '') ? 'post-renewal' : null;
    if (!t || !phase) {
      review.push({ kind: 'renewal-unmatched', key: sourceKey, message: `Toilet Renewal row ${rec.rowIndex} "${rec.get('Location')}" (section ${rec.section}) not matched`, resolution: 'auto: ignored' });
      continue;
    }
    if (phase === 'pre-renewal') {
      t.surveys.push(surveyFromRecord(rec, sourceKey, PRE_RENEWAL_DATE, phase, 'Toilet Renewal', review));
      preRenewal++;
    } else {
      const main = t.surveys[0]!;
      const same = COMPARE_COLS.every((c) => num(String(main.raw[c] ?? '')) === num(rec.get(c)));
      if (same) {
        // The General Data row *is* the post-renewal survey: tag it instead of duplicating it.
        main.phase = 'post-renewal';
        main.key = `${sourceKey}#post-renewal#${FIELDWORK_DATE}`;
      } else {
        t.surveys.push(surveyFromRecord(rec, sourceKey, FIELDWORK_DATE, phase, 'Toilet Renewal', review));
      }
      postRenewal++;
    }
  }

  const underRenewal = new Set<string>();
  collectBlock(renewalRows, /^under renewal$/i, 4).forEach((s) => underRenewal.add(s));
  collectBlock(miscRows, /^toilets under renovation$/i, 4).forEach((s) => underRenewal.add(s));
  const underRenewalKeys: string[] = [];
  for (const name of [...underRenewal].sort()) {
    const parsed = parseLocation(name);
    const venueKey = venueKeyFor(parsed.name, 'MRT_STATION');
    let sourceKey = toiletSourceKey(parsed.original);
    let t = toilets.get(sourceKey);
    if (!t && !parsed.lines.length) {
      const atVenue = [...toilets.values()].filter((x) => x.venueKey === venueKey);
      if (atVenue.length === 1) t = atVenue[0];
    }
    if (t) {
      t.needsResurvey = true;
      sourceKey = t.sourceKey;
    } else {
      ensureVenue(parsed, 'MRT_STATION');
      toilets.set(sourceKey, {
        sourceKey,
        venueKey,
        type: 'MRT_STATION',
        parsed,
        status: 'RENOVATION',
        needsResurvey: true,
        features: new Map(),
        surveys: [],
      });
    }
    underRenewalKeys.push(sourceKey);
  }

  // 4. Miscellaneous: stations without toilets / using nearby toilets / handicapped-only.
  const misc = parseMiscStations(miscRows);
  const toiletsAt = (venueKey: string) => [...toilets.values()].filter((t) => t.venueKey === venueKey);
  for (const p of misc.noToilet) {
    const v = ensureVenue(p, 'MRT_STATION');
    if (toiletsAt(v.key).length) {
      v.notes.push(`No toilet on the ${p.lines.join('/') || 'this'} side (fieldwork Mar 2024).`);
    } else {
      v.forcedStatus = 'NONE';
      v.notes.push('No toilet at this station (fieldwork Mar 2024).');
    }
  }
  for (const { parsed: p, note } of misc.usesNearby) {
    const v = ensureVenue(p, 'MRT_STATION');
    if (toiletsAt(v.key).length) {
      v.notes.push(`${p.lines.join('/')} side: ${note}.`);
    } else {
      v.forcedStatus = 'USES_NEARBY';
      v.notes.push(`${note}.`);
    }
    v.usesNearbyNote = note;
  }
  for (const p of misc.handicappedOnly) {
    const key = venueKeyFor(p.name, 'MRT_STATION');
    const matches = toiletsAt(key).filter((t) => !p.lines.length || p.lines.some((l) => t.parsed.lines.includes(l)));
    if (!matches.length)
      review.push({ kind: 'misc-unmatched', key, message: `Miscellaneous "handicapped only" station ${p.original} has no toilet row`, resolution: 'auto: ignored' });
    for (const t of matches) applyHandicappedOnly(t.features);
  }

  // 5. Assemble curated output.
  const venueList: CuratedVenue[] = [...venues.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((v) => {
      const hasToilets = toiletsAt(v.key).length > 0;
      let usesNearbyVenueKey: string | null = null;
      if (v.usesNearbyNote) {
        const nk = nameKey(v.usesNearbyNote);
        const other = [...venues.values()].find(
          (o) => o.key !== v.key && nk.includes(nameKey(o.name.replace(/\s*\(.*\)\s*/g, ' '))),
        );
        usesNearbyVenueKey = other?.key ?? null;
      }
      return {
        key: v.key,
        sourceKey: `sheet-venue:${v.key}`,
        name: v.name,
        type: v.type,
        lines: v.lines,
        toiletStatus: v.forcedStatus && !hasToilets ? v.forcedStatus : hasToilets ? 'HAS_TOILETS' : 'UNKNOWN',
        note: v.notes.length ? v.notes.join(' ') : null,
        openingHours: INFERRED_HOURS[v.type],
        geocode: geocodeQueryFor(rawNameOf(v), v.type),
        usesNearbyVenueKey,
      };
    });

  const toiletList: CuratedToilet[] = [...toilets.values()]
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))
    .map((t) => {
      const v = venues.get(t.venueKey)!;
      return {
        sourceKey: t.sourceKey,
        venueKey: t.venueKey,
        location: t.parsed.original,
        label: toiletLabel(t.parsed, v.lines, toiletsAt(v.key).length),
        level: t.parsed.level,
        lines: t.parsed.lines,
        status: t.status,
        tier: 'VERIFIED' as const,
        areaType: 'UNKNOWN' as const,
        lastVerifiedAt: FIELDWORK_DATE,
        needsResurvey: t.needsResurvey,
        features: FEATURES.filter((f) => t.features.has(f)).map((f) => ({ feature: f, present: t.features.get(f)! })),
        surveys: t.surveys,
      };
    });

  const keys = new Set<string>();
  for (const t of toiletList) {
    if (keys.has(t.sourceKey)) throw new Error(`Duplicate toilet sourceKey ${t.sourceKey}`);
    keys.add(t.sourceKey);
  }

  const fieldwork = FieldworkSchema.parse({
    source: {
      sheetId: SHEET_ID,
      observedAt: FIELDWORK_DATE,
      note: 'SMU fieldwork 13-17 Mar 2024. Generated by `pnpm cli sheet:normalise` from data/raw/sheet/*.csv; do not edit by hand (use overrides.json / enrichment.csv).',
    },
    venues: venueList,
    toilets: toiletList,
  });

  const byType: Record<string, number> = {};
  for (const t of toiletList) if (t.surveys.length) byType[t.venueKey.split('-')[0]!] = (byType[t.venueKey.split('-')[0]!] ?? 0) + 1;
  const stats = {
    generalDataToilets: generalCount,
    toiletsTotal: toiletList.length,
    surveyedToiletsByVenuePrefix: byType,
    venues: venueList.length,
    venuesByStatus: countBy(venueList, (v) => v.toiletStatus),
    surveys: toiletList.reduce((s, t) => s + t.surveys.length, 0),
    rasRated,
    rasBlank,
    preRenewal,
    postRenewal,
    underRenewal: underRenewalKeys,
    reviewItems: review.length,
  };
  return { fieldwork, review, stats };
}

function rawNameOf(v: VenueDraft): string {
  // Geocode by the sheet name (displayName adds "Bus Interchange" / "Community Club", which OneMap knows too).
  return v.rawName;
}

function countBy<T>(xs: T[], f: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[f(x)] = (out[f(x)] ?? 0) + 1;
  return out;
}

export function applyHandicappedOnly(features: Map<FeatureName, boolean>): void {
  features.set('MALE', false);
  features.set('FEMALE', false);
  features.set('ACCESSIBLE', true);
  features.set('UNISEX', true);
}

/** Names listed under a heading row (first `maxCol` columns), until a blank row / next heading. */
export function collectBlock(rows: string[][], heading: RegExp, maxCol: number): string[] {
  const start = rows.findIndex((r) => heading.test(clean(r[0])));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < rows.length; i++) {
    const cells = rows[i]!.slice(0, maxCol).map(clean);
    if (cells.every((c) => !c)) break;
    if (cells.filter(Boolean).length === 1 && /^(stations|toilets|post|pre)/i.test(cells[0]!)) break;
    out.push(...cells.filter(Boolean));
  }
  return out;
}

export interface MiscStations {
  noToilet: ParsedLocation[];
  usesNearby: { parsed: ParsedLocation; note: string }[];
  handicappedOnly: ParsedLocation[];
}

/** Parse the "Stations without Toilets" block of the Miscellaneous tab. */
export function parseMiscStations(rows: string[][]): MiscStations {
  const out: MiscStations = { noToilet: [], usesNearby: [], handicappedOnly: [] };
  const start = rows.findIndex((r) => /^stations without toilets$/i.test(clean(r[0])));
  if (start < 0) return out;
  for (let i = start + 1; i < rows.length; i++) {
    const s = clean(rows[i]![0]);
    if (!s) break;
    const m = /^(.*?)\s*\((.+)\)\s*$/.exec(s);
    if (!m) {
      out.noToilet.push(parseLocation(s));
      continue;
    }
    const [, body, paren] = m as unknown as [string, string, string];
    if (/handicap/i.test(paren)) {
      const parts = body.split(',').map((x) => parseLocation(x));
      const shared = parts.flatMap((p) => p.lines);
      for (const p of parts) out.handicappedOnly.push(p.lines.length ? p : { ...p, lines: [...new Set(shared)] });
    } else {
      out.usesNearby.push({ parsed: parseLocation(body), note: paren.trim() });
    }
  }
  return out;
}

export function runNormalise(): { log: Record<string, unknown> } {
  const { fieldwork, review, stats } = normaliseSheet();
  writeJson(paths.fieldwork, fieldwork);
  const existing = loadReview();
  writeJson(paths.review, { ...existing, normalise: review });
  console.log('  wrote data/curated/fieldwork-2024.json');
  console.log(`  ${review.length} review item(s) -> data/curated/review.json (normalise section)`);
  console.log(JSON.stringify(stats, null, 2));
  return { log: stats };
}


