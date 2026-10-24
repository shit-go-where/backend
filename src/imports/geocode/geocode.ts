import fs from 'node:fs';
import path from 'node:path';
import {
  loadFieldwork,
  loadFieldwork2024b,
  loadGeocoded,
  loadOverrides,
  loadReview,
  loadSurvey2Matches,
  type GeocodedVenue,
  type Override,
  type ReviewItem,
} from '../curated/schema.js';
import { writeJson } from '../lib/files.js';
import { haversineM, inSingapore } from '../lib/geo.js';
import { cachedJson, fetchJson, type CacheMode } from '../lib/http.js';
import { paths } from '../lib/paths.js';
import { nameKey, slugify } from '../lib/slug.js';
import { loadActiveMetroStations, type WikidataStation } from '../wikidata/stations.js';
import { loadPlanningAreas } from './planningArea.js';

export interface OneMapResult {
  SEARCHVAL: string;
  BLK_NO?: string;
  ROAD_NAME?: string;
  BUILDING: string;
  ADDRESS: string;
  POSTAL: string;
  LATITUDE: string;
  LONGITUDE: string;
}

interface OneMapResponse {
  found: number;
  totalNumPages: number;
  results: OneMapResult[];
}

export async function oneMapSearch(query: string, mode: CacheMode = {}): Promise<OneMapResponse> {
  const file = path.join(paths.geocodeCacheDir, 'onemap', `${slugify(query) || 'empty'}.json`);
  return cachedJson(
    file,
    async () => {
      const url =
        'https://www.onemap.gov.sg/api/common/elastic/search?searchVal=' +
        encodeURIComponent(query) +
        '&returnGeom=Y&getAddrDetails=Y&pageNum=1';
      const j = await fetchJson<OneMapResponse & { error?: string }>(url, { minIntervalMs: 260 });
      // Drop the "token missing" notice: search works anonymously.
      return { query, found: j.found, totalNumPages: j.totalNumPages, results: j.results ?? [] };
    },
    mode,
  );
}

export interface Pick {
  lat: number;
  lng: number;
  address: string | null;
  postalCode: string | null;
  matched: string | null;
  candidates: number;
  /** Max distance between plausible candidates (m): large = ambiguous. */
  spreadM: number;
}

const toPick = (rs: OneMapResult[], total: number): Pick => {
  const first = rs[0]!;
  const lat0 = Number(first.LATITUDE);
  const lng0 = Number(first.LONGITUDE);
  const spreadM = Math.max(0, ...rs.map((r) => haversineM(lat0, lng0, Number(r.LATITUDE), Number(r.LONGITUDE))));
  const withPostal = rs.find((r) => r.POSTAL && r.POSTAL !== 'NIL') ?? first;
  return {
    lat: lat0,
    lng: lng0,
    address: titleAddress(withPostal.ADDRESS),
    postalCode: withPostal.POSTAL && withPostal.POSTAL !== 'NIL' ? withPostal.POSTAL : null,
    matched: first.SEARCHVAL,
    candidates: total,
    spreadM: Math.round(spreadM),
  };
};

/**
 * MRT: keep results whose SEARCHVAL is "<NAME> MRT STATION" (optionally with a "(EW16)" code)
 * and average the station entries (one per line at interchanges) into a centroid.
 */
export function pickMrt(stationName: string, results: OneMapResult[]): Pick | null {
  const want = nameKey(stationName);
  const hits = results.filter((r) => {
    const sv = nameKey(r.SEARCHVAL.replace(/\(.*?\)/g, ' '));
    return sv === `${want} mrt station` || sv === `${want} lrt station` || sv === `${want} mrt lrt station`;
  });
  if (!hits.length) return null;
  const p = toPick(hits, hits.length);
  // Centroid of the entries close to the first (interchange platforms are within ~300 m).
  const close = hits.filter((r) => haversineM(p.lat, p.lng, Number(r.LATITUDE), Number(r.LONGITUDE)) < 400);
  p.lat = close.reduce((s, r) => s + Number(r.LATITUDE), 0) / close.length;
  p.lng = close.reduce((s, r) => s + Number(r.LONGITUDE), 0) / close.length;
  return p;
}

/**
 * Postcode search (coffeeshops, hawker centres): OneMap returns the building(s) with that postcode;
 * take the first whose POSTAL is exactly it. Every hit is the same building, so no spread check.
 */
export function pickPostal(postalCode: string, results: OneMapResult[]): Pick | null {
  const rs = results.filter((r) => r.POSTAL === postalCode);
  if (!rs.length) return null;
  return { ...toPick(rs.slice(0, 1), results.length), spreadM: 0 };
}

/** Places: prefer results whose BUILDING/SEARCHVAL contains the query (or `pick`). */
export function pickPlace(query: string, results: OneMapResult[], pick?: string): Pick | null {
  let rs = results;
  if (pick) {
    const pk = nameKey(pick);
    rs = rs.filter((r) => nameKey(`${r.SEARCHVAL} ${r.ADDRESS}`).includes(pk));
  } else {
    const q = nameKey(query);
    const named = rs.filter((r) => nameKey(`${r.SEARCHVAL} ${r.BUILDING}`).includes(q));
    if (named.length) rs = named;
  }
  if (!rs.length) return null;
  return toPick(rs, results.length);
}

function titleAddress(a: string | undefined): string | null {
  if (!a) return null;
  return a
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bMrt\b/g, 'MRT')
    .replace(/\bLrt\b/g, 'LRT')
    .replace(/\bHdb\b/g, 'HDB');
}

/** What geocodeVenue needs of a venue: a pilot CuratedVenue or a survey2 venue. */
export interface GeocodeTarget {
  key: string;
  name: string;
  type: string;
  geocode: { strategy: 'mrt' | 'place' | 'postal'; query: string; fallbackQuery?: string };
}

export interface GeocodeOutcome<V extends GeocodeTarget = GeocodeTarget> {
  venue: V;
  result: GeocodedVenue | null;
  issues: string[];
}

export async function geocodeVenue<V extends GeocodeTarget>(
  venue: V,
  override: Override | undefined,
  stations: WikidataStation[],
  mode: CacheMode,
): Promise<GeocodeOutcome<V>> {
  const issues: string[] = [];
  const query = override?.query ?? venue.geocode.query;
  let pick: Pick | null = null;
  let method: GeocodedVenue['method'] = 'onemap';
  let res: OneMapResponse | null = null;
  try {
    res = await oneMapSearch(query, mode);
  } catch (err) {
    issues.push(`OneMap error: ${(err as Error).message}`);
  }
  if (res) {
    pick =
      venue.geocode.strategy === 'mrt' && !override?.pick
        ? pickMrt(venue.name, res.results)
        : venue.geocode.strategy === 'postal' && !override?.query && !override?.pick
          ? pickPostal(query, res.results)
          : pickPlace(query, res.results, override?.pick);
    if (!pick) issues.push(`no OneMap match for "${query}" (${res.found} results)`);
    else if (pick.spreadM > (venue.geocode.strategy === 'mrt' ? 500 : 300)) issues.push(`multi-hit: candidates spread ${pick.spreadM} m`);
  }
  // survey2 venues carry a second query (the index address, or the name for a postcode search).
  const fallback = venue.geocode.fallbackQuery;
  if (!pick && fallback && !override?.query) {
    try {
      const fb = await oneMapSearch(fallback, mode);
      pick = pickPlace(fallback, fb.results);
      if (pick) {
        issues.push(`used the fallback query "${fallback}"`);
        if (pick.spreadM > 300) issues.push(`multi-hit: candidates spread ${pick.spreadM} m`);
      }
    } catch (err) {
      issues.push(`OneMap error: ${(err as Error).message}`);
    }
  }
  if (!pick && venue.type === 'MRT_STATION') {
    const want = nameKey(venue.name);
    const st = stations.find((s) => nameKey(s.name) === want);
    if (st) {
      pick = { lat: st.lat, lng: st.lng, address: null, postalCode: null, matched: `wikidata:${st.qid}`, candidates: 1, spreadM: 0 };
      method = 'wikidata';
      issues.push(`fell back to Wikidata ${st.qid}`);
    }
  }
  let result: GeocodedVenue | null = pick
    ? {
        lat: round6(pick.lat),
        lng: round6(pick.lng),
        name: null,
        address: pick.address,
        postalCode: pick.postalCode,
        planningArea: null,
        method,
        query: issues.some((i) => i.startsWith('used the fallback')) && fallback ? fallback : query,
        matched: pick.matched,
        candidates: pick.candidates,
      }
    : null;
  if (override && (override.lat !== undefined || override.name || override.address || override.postalCode)) {
    const base: GeocodedVenue = result ?? {
      lat: NaN,
      lng: NaN,
      name: null,
      address: null,
      postalCode: null,
      planningArea: null,
      method: 'override',
      query,
      matched: null,
      candidates: 0,
    };
    result = {
      ...base,
      lat: override.lat ?? base.lat,
      lng: override.lng ?? base.lng,
      name: override.name ?? base.name,
      address: override.address ?? base.address,
      postalCode: override.postalCode ?? base.postalCode,
      method: override.lat !== undefined ? 'override' : base.method,
    };
  }
  if (result && !inSingapore(result.lat, result.lng)) {
    issues.push(`outside Singapore bbox (${result.lat}, ${result.lng})`);
    result = null;
  }
  return { venue, result, issues };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

interface GeocodePass {
  out: Record<string, GeocodedVenue>;
  review: ReviewItem[];
  rows: string[][];
  unresolved: number;
}

/** Geocode one list of venues (pilot or survey2); overrides.json applies to both by venue key. */
async function geocodeList(
  venues: GeocodeTarget[],
  overrides: Record<string, Override>,
  stations: WikidataStation[],
  areas: Awaited<ReturnType<typeof loadPlanningAreas>>,
  mode: CacheMode,
  previous: Record<string, GeocodedVenue> = {},
): Promise<GeocodePass> {
  const pass: GeocodePass = { out: {}, review: [], rows: [], unresolved: 0 };
  for (const venue of venues) {
    const ov = overrides[venue.key];
    const { result, issues } = await geocodeVenue(venue, ov, stations, mode);
    if (result) {
      result.planningArea = areas.lookup(result.lat, result.lng);
      if (!result.planningArea) issues.push('no planning area polygon contains this point');
      // A geocode that moved a lot since the last run is worth a look (OneMap answers change).
      const before = previous[venue.key];
      if (before && haversineM(before.lat, before.lng, result.lat, result.lng) > 200)
        issues.push(`moved ${Math.round(haversineM(before.lat, before.lng, result.lat, result.lng))} m since the last run`);
      pass.out[venue.key] = result;
    } else {
      pass.unresolved++;
    }
    const resolution = ov ? `override in overrides.json${ov.reason ? `: ${ov.reason}` : ''}` : undefined;
    if (issues.length || !result || ov)
      pass.review.push({
        kind: result ? (ov ? 'geocode-overridden' : 'geocode-check') : 'geocode-failed',
        key: venue.key,
        message: `${venue.name}: ${issues.join('; ') || (result ? 'resolved via override' : 'unresolved')}`,
        ...(resolution ? { resolution } : {}),
        data: result ? { lat: result.lat, lng: result.lng, matched: result.matched } : undefined,
      });
    pass.rows.push([
      venue.key,
      result ? `${result.lat.toFixed(5)},${result.lng.toFixed(5)}` : 'UNRESOLVED',
      result?.method ?? '-',
      (result?.matched ?? '-').slice(0, 40),
      result?.planningArea ?? '-',
      issues.join('; ').slice(0, 60),
    ]);
  }
  return pass;
}

const passLog = (venues: number, p: GeocodePass) => ({
  venues,
  resolved: Object.keys(p.out).length,
  unresolved: p.unresolved,
  byMethod: Object.values(p.out).reduce<Record<string, number>>((m, g) => ((m[g.method] = (m[g.method] ?? 0) + 1), m), {}),
  withPlanningArea: Object.values(p.out).filter((g) => g.planningArea).length,
  reviewItems: p.review.length,
});

function printTable(rows: string[][], header: string[], widths: number[]): void {
  const fmt = (r: string[]) => r.map((c, i) => (i < widths.length ? c.slice(0, widths[i]).padEnd(widths[i]!) : c)).join(' ');
  console.log(fmt(header));
  for (const r of rows) console.log(fmt(r));
}

/**
 * Pilot venues -> venues.geocoded.json (+ review.json `geocode`), then, when fieldwork-2024b.json
 * exists, the expanded survey's venues -> survey2-venues.geocoded.json (+ review.json `survey2Geocode`).
 * Survey2 venues that `survey2:match` tied to an existing venue are geocoded too, so the table shows how
 * far our geocode is from that venue; the seed uses the existing venue's coordinates for them.
 */
export async function runGeocode(mode: CacheMode = {}): Promise<{ log: Record<string, unknown> }> {
  const fieldwork = loadFieldwork();
  const overrides = loadOverrides();
  const stations = await loadActiveMetroStations(mode).catch((err) => {
    console.warn(`  Wikidata stations unavailable: ${(err as Error).message}`);
    return [] as WikidataStation[];
  });
  const areas = await loadPlanningAreas(mode);

  // ── Pilot (March 2024)
  const pilot = await geocodeList(fieldwork.venues, overrides, stations, areas, mode);
  const survey2 = fs.existsSync(paths.fieldwork2024b) ? loadFieldwork2024b() : null;
  const knownKeys = new Set([...fieldwork.venues.map((v) => v.key), ...(survey2?.venues.map((v) => v.key) ?? [])]);
  // Overrides for keys that no longer exist are worth flagging.
  for (const k of Object.keys(overrides))
    if (!knownKeys.has(k)) pilot.review.push({ kind: 'override-orphan', key: k, message: `overrides.json has "${k}" but no such venue` });
  writeJson(paths.geocoded, pilot.out);
  writeJson(paths.review, { ...loadReview(), geocode: pilot.review });
  printTable(pilot.rows, ['venue', 'lat,lng', 'method', 'matched', 'planning area', 'issues'], [38, 20, 9, 40, 22, 60]);
  const log: Record<string, unknown> = { pilot: passLog(fieldwork.venues.length, pilot) };

  // ── Expanded survey (Aug-Oct 2024)
  let unresolved2 = 0;
  if (survey2) {
    const previous = loadGeocoded(paths.survey2Geocoded);
    const s2 = await geocodeList(survey2.venues, overrides, stations, areas, mode, previous);
    unresolved2 = s2.unresolved;
    // Distance to the venue survey2:match picked (pilot venues, Wikidata stations, data.gov.sg / OSM points).
    const matches = loadSurvey2Matches();
    const pilotGeo = pilot.out;
    const pilotByKey = new Map(fieldwork.venues.map((v) => [v.sourceKey, v.key]));
    const rows = s2.rows.map((r) => {
      const v = survey2.venues.find((x) => x.key === r[0])!;
      const m = matches?.venues[v.key];
      const target = m?.existingVenueSourceKey ?? null;
      let dist = m?.distanceM ?? null;
      const pk = target ? pilotByKey.get(target) : undefined;
      const g = s2.out[v.key];
      if (pk && g && pilotGeo[pk]) dist = Math.round(haversineM(g.lat, g.lng, pilotGeo[pk]!.lat, pilotGeo[pk]!.lng));
      if (target && g && dist !== null && dist > 400 && v.type !== 'MRT_STATION')
        s2.review.push({
          kind: 'geocode-far-from-match',
          key: v.key,
          message: `${v.name}: our geocode is ${dist} m from the matched venue ${target}`,
          resolution: 'check survey2-venue-matches.json (the seed uses the matched venue, not this geocode)',
        });
      return [r[0]!, v.type.slice(0, 11), v.name.slice(0, 36), ...r.slice(1, 5), target ?? 'NEW', dist === null ? '-' : String(dist), r[5]!];
    });
    writeJson(paths.survey2Geocoded, s2.out);
    writeJson(paths.review, { ...loadReview(), survey2Geocode: s2.review });
    console.log('\n  expanded survey (survey2) venues -> data/curated/survey2-venues.geocoded.json');
    printTable(
      rows,
      ['code', 'type', 'name', 'lat,lng', 'method', 'matched', 'planning area', 'match', 'dist m', 'issues'],
      [6, 11, 36, 20, 9, 34, 18, 44, 6],
    );
    log['survey2'] = passLog(survey2.venues.length, s2);
  }

  console.log(JSON.stringify(log, null, 2));
  const unresolved = pilot.unresolved + unresolved2;
  if (unresolved) throw new Error(`${unresolved} venue(s) unresolved: add overrides in data/curated/overrides.json`);
  return { log };
}
