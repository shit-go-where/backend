import path from 'node:path';
import {
  loadFieldwork,
  loadOverrides,
  loadReview,
  type CuratedVenue,
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

export interface GeocodeOutcome {
  venue: CuratedVenue;
  result: GeocodedVenue | null;
  issues: string[];
}

export async function geocodeVenue(
  venue: CuratedVenue,
  override: Override | undefined,
  stations: WikidataStation[],
  mode: CacheMode,
): Promise<GeocodeOutcome> {
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
        : pickPlace(query, res.results, override?.pick);
    if (!pick) issues.push(`no OneMap match for "${query}" (${res.found} results)`);
    else if (pick.spreadM > (venue.geocode.strategy === "mrt" ? 500 : 300)) issues.push(`multi-hit: candidates spread ${pick.spreadM} m`);
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
        query,
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

export async function runGeocode(mode: CacheMode = {}): Promise<{ log: Record<string, unknown> }> {
  const fieldwork = loadFieldwork();
  const overrides = loadOverrides();
  const stations = await loadActiveMetroStations(mode).catch((err) => {
    console.warn(`  Wikidata stations unavailable: ${(err as Error).message}`);
    return [] as WikidataStation[];
  });
  const areas = await loadPlanningAreas(mode);

  const out: Record<string, GeocodedVenue> = {};
  const review: ReviewItem[] = [];
  const rows: string[][] = [];
  let unresolved = 0;
  for (const venue of fieldwork.venues) {
    const ov = overrides[venue.key];
    const { result, issues } = await geocodeVenue(venue, ov, stations, mode);
    if (result) {
      result.planningArea = areas.lookup(result.lat, result.lng);
      if (!result.planningArea) issues.push('no planning area polygon contains this point');
      out[venue.key] = result;
    } else {
      unresolved++;
    }
    const resolution = ov ? `override in overrides.json${ov.reason ? `: ${ov.reason}` : ''}` : undefined;
    if (issues.length || !result || ov)
      review.push({
        kind: result ? (ov ? 'geocode-overridden' : 'geocode-check') : 'geocode-failed',
        key: venue.key,
        message: `${venue.name}: ${issues.join('; ') || (result ? 'resolved via override' : 'unresolved')}`,
        ...(resolution ? { resolution } : {}),
        data: result ? { lat: result.lat, lng: result.lng, matched: result.matched } : undefined,
      });
    rows.push([
      venue.key,
      result ? `${result.lat.toFixed(5)},${result.lng.toFixed(5)}` : 'UNRESOLVED',
      result?.method ?? '-',
      (result?.matched ?? '-').slice(0, 40),
      result?.planningArea ?? '-',
      issues.join('; ').slice(0, 60),
    ]);
  }
  // Overrides for keys that no longer exist are worth flagging.
  for (const k of Object.keys(overrides))
    if (!fieldwork.venues.some((v) => v.key === k))
      review.push({ kind: 'override-orphan', key: k, message: `overrides.json has "${k}" but no such venue` });

  writeJson(paths.geocoded, out);
  writeJson(paths.review, { ...loadReview(), geocode: review });

  const widths = [38, 20, 9, 40, 22, 60];
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join(' ');
  console.log(fmt(['venue', 'lat,lng', 'method', 'matched', 'planning area', 'issues']));
  for (const r of rows) console.log(fmt(r));
  const log = {
    venues: fieldwork.venues.length,
    resolved: Object.keys(out).length,
    unresolved,
    byMethod: Object.values(out).reduce<Record<string, number>>((m, g) => ((m[g.method] = (m[g.method] ?? 0) + 1), m), {}),
    withPlanningArea: Object.values(out).filter((g) => g.planningArea).length,
    reviewItems: review.length,
  };
  console.log(JSON.stringify(log, null, 2));
  if (unresolved) throw new Error(`${unresolved} venue(s) unresolved: add overrides in data/curated/overrides.json`);
  return { log };
}
