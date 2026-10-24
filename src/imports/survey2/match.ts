/**
 * `survey2:match`: decide, for every venue of the expanded survey, whether it is a place we already
 * have (reuse that venue) or a new one, and which survey2 rows are another survey of a pilot toilet.
 * Offline and deterministic; writes data/curated/survey2-venue-matches.json (hand-editable: entries
 * with `"locked": true` are kept) and the `survey2Match` section of review.json, and prints a table.
 *
 * Sources, in order: the pilot fieldwork venues (fieldwork-2024.json + venues.geocoded.json), Wikidata
 * stations (data/raw/wikidata/stations.json), data.gov.sg hawker centres (data/raw/datagov), OSM venues
 * (data/raw/osm/toilets.json, same type within 60 m of our geocode and a similar name).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadFieldwork,
  loadFieldwork2024b,
  loadGeocoded,
  loadReview,
  loadSurvey2Matches,
  type Fieldwork,
  type Fieldwork2024b,
  type GeocodedVenue,
  type ReviewItem,
  type Survey2Attach,
  type Survey2Matches,
  type Survey2Toilet,
  type Survey2Venue,
  type Survey2VenueMatch,
} from '../curated/schema.js';
import { featureAttributes } from '../lib/datagov.js';
import { readJson, writeJson } from '../lib/files.js';
import { haversineM, inSingapore } from '../lib/geo.js';
import { paths } from '../lib/paths.js';
import { nameKey, slugify } from '../lib/slug.js';
import { elementLatLng, isToiletsOnFeature, similarName, venueNameFromTags, venueTypeFromTags, type OsmElement } from '../osm/tags.js';
import type { WikidataStation } from '../wikidata/stations.js';
import { lineOfStationCode, premiseAliases } from './parse.js';

// ───────────────────────────── inputs ─────────────────────────────

export interface HawkerPoint {
  /** `datagov-hawker:<id>`, computed exactly as import:datagov does. */
  sourceKey: string;
  name: string;
  postalCode: string | null;
  lat: number;
  lng: number;
}
export interface OsmVenue {
  sourceKey: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
}
export interface MatchInputs {
  survey2: Fieldwork2024b;
  pilot: Fieldwork;
  pilotGeo: Record<string, GeocodedVenue>;
  /** Our geocode of the survey2 venues, when `geocode` has run. */
  survey2Geo: Record<string, GeocodedVenue>;
  stations: WikidataStation[];
  hawkers: HawkerPoint[];
  osm: OsmVenue[];
  previous: Survey2Matches | null;
}

/** data.gov.sg hawker centres -> the `datagov-hawker:` keys import:datagov gives them (same order, same dedupe). */
export function hawkerPoints(fc: { features: { properties: Record<string, unknown>; geometry: { type: string; coordinates: number[] } | null }[] }): HawkerPoint[] {
  const pts = fc.features
    .map((f) => {
      const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : null;
      return { a: featureAttributes(f.properties), lat: c?.[1] ?? NaN, lng: c?.[0] ?? NaN };
    })
    .filter((p) => inSingapore(p.lat, p.lng))
    .sort((x, y) => (x.a['NAME'] ?? '').localeCompare(y.a['NAME'] ?? '') || x.lat - y.lat);
  const seen = new Map<string, number>();
  const out: HawkerPoint[] = [];
  for (const p of pts) {
    const raw = p.a['NAME'] ?? '';
    if (!raw || /under construction/i.test(p.a['STATUS'] ?? '')) continue;
    const base = slugify(raw);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ sourceKey: `datagov-hawker:${n === 1 ? base : `${base}-${n}`}`, name: raw, postalCode: p.a['ADDRESSPOSTALCODE'] || null, lat: p.lat, lng: p.lng });
  }
  return out;
}

/** OSM shops/malls/... tagged toilets=yes: the venues import:osm creates as `osm-venue:<type>/<id>`. */
export function osmVenues(elements: OsmElement[]): OsmVenue[] {
  const out: OsmVenue[] = [];
  for (const e of elements) {
    const tags = e.tags ?? {};
    const ll = elementLatLng(e);
    if (!ll || !isToiletsOnFeature(tags) || !tags['name']) continue;
    out.push({ sourceKey: `osm-venue:${e.type}/${e.id}`, name: venueNameFromTags(tags), type: venueTypeFromTags(tags), lat: ll.lat, lng: ll.lng });
  }
  return out;
}

// ───────────────────────────── name comparison ─────────────────────────────

const STOP = new Set(['and', 'blk', 'blks', 'the', 'at', 'of', 'singapore']);
const tokens = (s: string) => nameKey(s.replace(/\bcenter\b/gi, 'centre')).split(' ').filter((w) => w && !STOP.has(w));

/**
 * Same place by name: equal name keys, or every word of the shorter name (at least two) is in the
 * longer one ("Chong Pang" / "Chong Pang Market & Food Centre", "Bukit Timah Interim Market" /
 * "Bukit Timah Interim Hawker Centre and Market").
 */
export function sameName(a: string, b: string): 'exact' | 'words' | null {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return null;
  if (ka === kb) return 'exact';
  const ta = tokens(a);
  const tb = tokens(b);
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length >= 2 && short.every((w) => long.includes(w))) return 'words';
  return null;
}

function bestName(aliases: string[], names: string[]): 'exact' | 'words' | null {
  let best: 'exact' | 'words' | null = null;
  for (const a of aliases)
    for (const n of names) {
      const r = sameName(a, n);
      if (r === 'exact') return r;
      if (r) best = r;
    }
  return best;
}

// ───────────────────────────── matching ─────────────────────────────

export interface MatchRow {
  code: string;
  type: string;
  name: string;
  decision: string;
  via: string;
  distanceM: number | null;
  detail: string;
}

export interface MatchResult {
  matches: Survey2Matches;
  review: ReviewItem[];
  rows: MatchRow[];
  stats: Record<string, unknown>;
}

const round = (n: number) => Math.round(n);
/** A matched venue further than this from our geocode is listed for review (the match is kept). */
const FAR_M = 400;
const OSM_RADIUS_M = 60;

type Candidate = { sourceKey: string; name: string; lat: number | null; lng: number | null; via: string; detail: string | null };

export function matchSurvey2(inp: MatchInputs): MatchResult {
  const review: ReviewItem[] = [];
  const venues: Record<string, Survey2VenueMatch> = {};
  const pilotVenues = inp.pilot.venues;
  const stationByCode = new Map<string, WikidataStation>();
  for (const s of inp.stations) for (const c of s.codes) stationByCode.set(c.toUpperCase(), s);
  const geoOf = (v: Survey2Venue) => inp.survey2Geo[v.key] ?? null;

  const findPilot = (v: Survey2Venue): Candidate | null => {
    const aliases = v.type === 'MRT_STATION' ? [v.name] : [v.name, ...(v.premise ? premiseAliases(v.premise) : [])];
    const hits: { pv: (typeof pilotVenues)[number]; how: 'exact' | 'words' | 'postcode' }[] = [];
    for (const pv of pilotVenues) {
      if (pv.type !== v.type) continue;
      const g = inp.pilotGeo[pv.key];
      // The pilot's display name, its overrides.json name and what OneMap matched ("BUKIT PANJANG INTEGRATED TRANSPORT HUB").
      const names = [pv.name, ...(g?.name ? [g.name] : []), ...(g?.matched && !g.matched.startsWith('wikidata:') ? [g.matched] : [])];
      const how = v.type === 'MRT_STATION' ? (names.some((n) => nameKey(n) === nameKey(v.name)) ? 'exact' : null) : bestName(aliases, names);
      if (how) hits.push({ pv, how });
      else if (v.type === 'COFFEESHOP' && v.postalCode && g?.postalCode === v.postalCode) hits.push({ pv, how: 'postcode' });
    }
    if (!hits.length) return null;
    hits.sort((a, b) => ['exact', 'words', 'postcode'].indexOf(a.how) - ['exact', 'words', 'postcode'].indexOf(b.how));
    const { pv, how } = hits[0]!;
    const g = inp.pilotGeo[pv.key];
    return {
      sourceKey: pv.sourceKey,
      name: g?.name ?? pv.name,
      lat: g?.lat ?? null,
      lng: g?.lng ?? null,
      via: `pilot-${how === 'postcode' ? 'postcode' : 'name'}`,
      detail:
        how === 'postcode'
          ? `same postcode ${v.postalCode} as pilot coffeeshop "${g?.name ?? pv.name}" (several coffeeshops can share a block: confirm the unit)`
          : how === 'words'
            ? `"${v.name}" and pilot "${g?.name ?? pv.name}" share every word of the shorter name`
            : null,
    };
  };

  const findStation = (v: Survey2Venue): Candidate | null => {
    const byCode = stationByCode.get(v.code);
    const st = byCode ?? inp.stations.find((s) => nameKey(s.name) === nameKey(v.name));
    if (!st) return null;
    return {
      sourceKey: `wikidata:${st.qid}`,
      name: st.name,
      lat: st.lat,
      lng: st.lng,
      via: byCode ? 'wikidata-code' : 'wikidata-name',
      detail: byCode ? null : `Wikidata ${st.qid} has no station code for ${v.code}; matched by name`,
    };
  };

  const findHawker = (v: Survey2Venue): Candidate | null => {
    const aliases = [v.name, ...(v.premise ? premiseAliases(v.premise) : [])];
    const byPostal = v.postalCode ? inp.hawkers.filter((h) => h.postalCode === v.postalCode) : [];
    // NEA names read "Redhill Lane Blk 79 (Redhill Market)": compare with both parts.
    const namesOf = (h: HawkerPoint) => [h.name, ...(/^(.*?)\s*\((.+)\)$/.exec(h.name)?.slice(1) ?? [])];
    if (byPostal.length === 1) return { sourceKey: byPostal[0]!.sourceKey, name: byPostal[0]!.name, lat: byPostal[0]!.lat, lng: byPostal[0]!.lng, via: 'datagov-postcode', detail: null };
    const named = (byPostal.length ? byPostal : inp.hawkers).filter((h) => bestName(aliases, namesOf(h)));
    if (named.length === 1)
      return {
        sourceKey: named[0]!.sourceKey,
        name: named[0]!.name,
        lat: named[0]!.lat,
        lng: named[0]!.lng,
        via: 'datagov-name',
        detail: `matched by name ("${v.name}" ~ "${named[0]!.name}")${v.postalCode ? `; NEA postcode differs from ${v.postalCode}` : ''}`,
      };
    return null;
  };

  const findOsm = (v: Survey2Venue): Candidate | null => {
    const g = geoOf(v);
    if (!g) return null;
    const aliases = [v.name, ...(v.premise ? premiseAliases(v.premise) : [])];
    const near = inp.osm
      .filter((o) => o.type === v.type)
      .map((o) => ({ o, d: haversineM(g.lat, g.lng, o.lat, o.lng) }))
      .filter(({ o, d }) => d <= OSM_RADIUS_M && aliases.some((a) => similarName(a, o.name)))
      .sort((a, b) => a.d - b.d);
    if (!near.length) return null;
    const { o, d } = near[0]!;
    return { sourceKey: o.sourceKey, name: o.name, lat: o.lat, lng: o.lng, via: 'osm-60m-name', detail: `OSM "${o.name}" ${round(d)} m from our geocode` };
  };

  for (const v of inp.survey2.venues) {
    const prev = inp.previous?.venues[v.key];
    if (prev?.locked) {
      venues[v.key] = prev;
      continue;
    }
    const cand =
      findPilot(v) ??
      (v.type === 'MRT_STATION' ? findStation(v) : null) ??
      (v.type === 'HAWKER_CENTRE' ? findHawker(v) : null) ??
      findOsm(v);
    const g = geoOf(v);
    const distanceM = cand && g && cand.lat !== null && cand.lng !== null ? round(haversineM(g.lat, g.lng, cand.lat, cand.lng)) : null;
    venues[v.key] = {
      name: v.name,
      type: v.type,
      existingVenueSourceKey: cand?.sourceKey ?? null,
      existingVenueName: cand?.name ?? null,
      via: cand ? cand.via : g ? 'no-match' : 'no-match (not geocoded yet: OSM not tried)',
      detail: cand?.detail ?? null,
      distanceM,
      locked: false,
    };
    if (cand && (cand.detail || (distanceM !== null && distanceM > FAR_M && v.type !== 'MRT_STATION') || (distanceM !== null && distanceM > 1000)))
      review.push({
        kind: 'survey2-match-check',
        key: v.key,
        message: `${v.key} "${v.name}" -> ${cand.sourceKey} "${cand.name}" via ${cand.via}${distanceM !== null ? `, ${distanceM} m from our geocode` : ''}${cand.detail ? `: ${cand.detail}` : ''}`,
        resolution: 'auto: matched. To overrule, edit the entry in survey2-venue-matches.json and set "locked": true.',
      });
  }

  // Several survey2 venues on one existing venue is expected for stations (one code per line), not otherwise.
  const byTarget = new Map<string, string[]>();
  for (const [code, m] of Object.entries(venues)) if (m.existingVenueSourceKey) byTarget.set(m.existingVenueSourceKey, [...(byTarget.get(m.existingVenueSourceKey) ?? []), code]);
  for (const [target, codes] of byTarget)
    if (codes.length > 1 && codes.some((c) => venues[c]!.type !== 'MRT_STATION'))
      review.push({
        kind: 'survey2-match-shared',
        key: codes.join(','),
        message: `${codes.join(', ')} all match ${target}`,
        resolution: 'auto: all reuse that venue. Lock a different decision if they are different places.',
      });

  const attach = planAttachments(inp, venues, review);

  const rows: MatchRow[] = inp.survey2.venues.map((v) => {
    const m = venues[v.key]!;
    return {
      code: v.key,
      type: v.type,
      name: v.name,
      decision: m.existingVenueSourceKey ?? 'NEW',
      via: `${m.via}${m.locked ? ' (locked)' : ''}`,
      distanceM: m.distanceM,
      detail: m.detail ?? '',
    };
  });
  const count = (f: (m: Survey2VenueMatch) => string) =>
    Object.values(venues).reduce<Record<string, number>>((acc, m) => ((acc[f(m)] = (acc[f(m)] ?? 0) + 1), acc), {});
  const attachValues = Object.values(attach);
  const stats = {
    venues: Object.keys(venues).length,
    byDecision: count((m) => `${m.type} ${m.existingVenueSourceKey ? m.existingVenueSourceKey.split(':')[0] : 'new'}`),
    locked: Object.values(venues).filter((m) => m.locked).length,
    attachListed: attachValues.length,
    attached: attachValues.filter((a) => a.pilotToiletSourceKey).length,
    attachVia: attachValues.reduce<Record<string, number>>((acc, a) => ((acc[a.via] = (acc[a.via] ?? 0) + 1), acc), {}),
    reviewItems: review.reduce<Record<string, number>>((acc, r) => ((acc[r.kind] = (acc[r.kind] ?? 0) + 1), acc), {}),
  };
  return {
    matches: {
      note: 'Generated by `pnpm cli survey2:match`; review it. Set "locked": true on any entry you change by hand and the next run keeps it. existingVenueSourceKey null = a new survey2-venue:<CODE> venue; attach.pilotToiletSourceKey null = a toilet of its own.',
      venues,
      attach,
    },
    review,
    rows,
    stats,
  };
}

/** Pilot sex of a pilot toilet: the 3 handicapped-only rows are UNISEX, everything else the pilot saw is MALE. */
const pilotSex = (t: Fieldwork['toilets'][number]) => (t.features.some((f) => f.feature === 'UNISEX' && f.present) ? 'UNISEX' : 'MALE');

/**
 * Survey2 rows at a venue matched to a pilot venue, of the sex the pilot saw there: which pilot toilet
 * each is another survey of. At a station the line picks the pilot toilet (EW16 -> sheet:outram-park-ewl);
 * one candidate is enough elsewhere unless its level disagrees. Several survey2 rows on one candidate:
 * the ones with no location given are taken to be that toilet; rows that name a level/spot are new.
 */
function planAttachments(inp: MatchInputs, venues: Record<string, Survey2VenueMatch>, review: ReviewItem[]): Record<string, Survey2Attach> {
  const out: Record<string, Survey2Attach> = {};
  const pilotByVenueSourceKey = new Map(inp.pilot.venues.map((v) => [v.sourceKey, v]));
  const toiletsByVenueKey = new Map<string, Fieldwork['toilets']>();
  for (const t of inp.pilot.toilets) toiletsByVenueKey.set(t.venueKey, [...(toiletsByVenueKey.get(t.venueKey) ?? []), t]);

  const byCodeSex = new Map<string, Survey2Toilet[]>();
  for (const t of inp.survey2.toilets) byCodeSex.set(`${t.code}/${t.sex}`, [...(byCodeSex.get(`${t.code}/${t.sex}`) ?? []), t]);

  const set = (t: Survey2Toilet, a: Omit<Survey2Attach, 'locked'>) => {
    const prev = inp.previous?.attach[t.sourceKey];
    out[t.sourceKey] = prev?.locked ? prev : { ...a, locked: false };
  };

  for (const [key, rows] of [...byCodeSex].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) {
    const [code, sex] = key.split('/') as [string, string];
    const m = venues[code];
    const pv = m?.existingVenueSourceKey ? pilotByVenueSourceKey.get(m.existingVenueSourceKey) : undefined;
    if (!pv) continue;
    const all = toiletsByVenueKey.get(pv.key) ?? [];
    let cands = all.filter((t) => pilotSex(t) === sex);
    if (!cands.length) {
      if (all.length && sex === 'MALE')
        for (const t of rows) {
          set(t, { pilotToiletSourceKey: null, via: 'no-pilot-toilet-of-this-sex', detail: `pilot toilets here: ${all.map((x) => `${x.sourceKey} (${pilotSex(x)})`).join(', ')}` });
          review.push({
            kind: 'survey2-attach-none',
            key: t.sourceKey,
            message: `${t.sourceKey} (${sex}) at pilot venue ${pv.sourceKey}, but the pilot only lists ${all.map((x) => `${x.sourceKey} (${pilotSex(x)})`).join(', ')}`,
            resolution: 'auto: a toilet of its own. Set attach.pilotToiletSourceKey and "locked": true if it is the same toilet.',
          });
        }
      continue;
    }
    let via = 'only-pilot-toilet';
    if (pv.type === 'MRT_STATION') {
      // The code's own line decides (EW16 -> EWL); a pilot toilet with no recorded line fits any.
      const own = lineOfStationCode(code);
      const onLine = cands.filter((c) => !c.lines.length || (own !== null && c.lines.includes(own)));
      if (cands.length > 1 || onLine.length !== cands.length) via = 'station-line';
      cands = onLine;
    }
    if (cands.length !== 1) {
      for (const t of rows) {
        set(t, { pilotToiletSourceKey: null, via: cands.length ? 'ambiguous' : 'line-mismatch', detail: cands.length ? `candidates ${cands.map((c) => c.sourceKey).join(', ')}` : `no ${sex} pilot toilet on ${t.lines.join('/') || code}` });
        review.push({
          kind: cands.length ? 'survey2-attach-ambiguous' : 'survey2-attach-none',
          key: t.sourceKey,
          message: cands.length
            ? `${t.sourceKey}: ${cands.length} pilot toilets fit (${cands.map((c) => c.sourceKey).join(', ')})`
            : `${t.sourceKey}: pilot venue ${pv.sourceKey} has ${sex} toilets only on other lines (${all.filter((x) => pilotSex(x) === sex).map((x) => `${x.sourceKey} ${x.lines.join('/')}`).join(', ')})`,
          resolution: 'auto: a toilet of its own. Set attach.pilotToiletSourceKey and "locked": true to attach it.',
        });
      }
      continue;
    }
    const c = cands[0]!;
    // Level: when the pilot recorded one, only rows on that level can be it.
    let fit = rows;
    if (c.level) {
      const same = rows.filter((r) => r.level === c.level);
      fit = same.length ? same : rows.filter((r) => !r.level);
      if (same.length) via = 'level';
    }
    let chosen: Survey2Toilet[];
    if (fit.length === 1) chosen = fit;
    else {
      chosen = fit.filter((r) => !r.location.trim());
      if (chosen.length) via = 'unnamed-rows';
    }
    for (const t of rows) {
      const on = chosen.includes(t);
      set(t, {
        pilotToiletSourceKey: on ? c.sourceKey : null,
        via: on ? via : 'other-spot',
        detail: on
          ? rows.length > 1
            ? `${rows.length} ${sex} rows at ${code}; this one ${t.location ? `("${t.location}")` : '(no location given)'} taken to be the pilot toilet`
            : null
          : `another ${sex} toilet at ${code} ("${t.location || 'no location given'}"); the pilot toilet is ${c.sourceKey}${c.level ? ` (${c.level})` : ''}`,
      });
    }
    if (rows.length > 1 || (chosen.length === 0 && rows.length))
      review.push({
        kind: chosen.length ? 'survey2-attach-check' : 'survey2-attach-none',
        key: `${code}/${sex}`,
        message: `${rows.length} ${sex} rows at ${code} (${pv.name}), one pilot toilet ${c.sourceKey}${c.level ? ` (${c.level})` : ''}: ${rows
          .map((r) => `${r.sourceKey}${chosen.includes(r) ? ' ATTACHED' : ' new'} "${r.location || '(no location)'}"`)
          .join('; ')}`,
        resolution: chosen.length
          ? 'auto: rows without a location are taken to be the pilot toilet; the others are new toilets. Lock a different choice in survey2-venue-matches.json if wrong.'
          : 'auto: none attached (every row names a spot); all are new toilets. Lock attach.pilotToiletSourceKey on the right one.',
      });
  }
  return out;
}

// ───────────────────────────── command ─────────────────────────────

function loadInputs(): MatchInputs {
  const stationsFile = path.join(paths.wikidataRawDir, 'stations.json');
  const stations = fs.existsSync(stationsFile)
    ? readJson<{ stations: WikidataStation[] }>(stationsFile).stations.filter((s) => s.inUse && s.isMetro && Number.isFinite(s.lat))
    : [];
  const hawkerFile = path.join(paths.datagovRawDir, 'hawker-centres.geojson');
  const osmFile = path.join(paths.osmRawDir, 'toilets.json');
  return {
    survey2: loadFieldwork2024b(),
    pilot: loadFieldwork(),
    pilotGeo: loadGeocoded(),
    survey2Geo: loadGeocoded(paths.survey2Geocoded),
    stations,
    hawkers: fs.existsSync(hawkerFile) ? hawkerPoints(readJson(hawkerFile)) : [],
    osm: fs.existsSync(osmFile) ? osmVenues(readJson<{ elements: OsmElement[] }>(osmFile).elements) : [],
    previous: loadSurvey2Matches(),
  };
}

export function printMatchTable(rows: MatchRow[]): void {
  const widths = [6, 15, 44, 50, 18, 7];
  const fmt = (r: string[]) => r.map((c, i) => (i < widths.length ? c.slice(0, widths[i]).padEnd(widths[i]!) : c)).join(' ');
  console.log(fmt(['code', 'type', 'name', 'decision', 'via', 'dist m', 'detail']));
  for (const r of rows) console.log(fmt([r.code, r.type, r.name, r.decision, r.via, r.distanceM === null ? '-' : String(r.distanceM), r.detail]));
}

export function runSurvey2Match(): { log: Record<string, unknown> } {
  const inp = loadInputs();
  if (!Object.keys(inp.survey2Geo).length) console.warn('  survey2 venues are not geocoded yet: OSM matching skipped. Run `pnpm cli geocode`, then this again.');
  const { matches, review, rows, stats } = matchSurvey2(inp);
  writeJson(paths.survey2Matches, matches);
  writeJson(paths.review, { ...loadReview(), survey2Match: review });
  printMatchTable(rows);
  console.log('  wrote data/curated/survey2-venue-matches.json');
  console.log(`  ${review.length} review item(s) -> data/curated/review.json (survey2Match section)`);
  console.log(JSON.stringify(stats, null, 2));
  return { log: stats };
}
