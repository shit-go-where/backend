import path from 'node:path';
import { cachedJson, fetchJson, type CacheMode } from '../lib/http.js';
import { paths } from '../lib/paths.js';

export const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';

/** Q-ids for Wikidata P5817 "state of use". */
const IN_USE = 'Q55654238';

/**
 * Singapore railway stations with coordinates. Classes: metro / railway / light-rail / underground /
 * elevated / people-mover station and tram stop (Wikidata models several LRT stations that way).
 */
export const STATIONS_QUERY = `
SELECT ?st ?stLabel ?coord ?opening ?lineLabel ?code ?instLabel ?state WHERE {
  ?st wdt:P17 wd:Q334; wdt:P625 ?coord; wdt:P31 ?inst.
  VALUES ?inst { wd:Q928830 wd:Q1268865 wd:Q55488 wd:Q55678 wd:Q22808404 wd:Q22808403 wd:Q4663385 wd:Q11670533 wd:Q63979268 wd:Q2175765 }
  OPTIONAL { ?st wdt:P1619 ?opening }
  OPTIONAL { ?st wdt:P81 ?line }
  OPTIONAL { ?st wdt:P296 ?code }
  OPTIONAL { ?st wdt:P5817 ?state }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

export interface WikidataStation {
  qid: string;
  label: string;
  /** Label without "MRT station"/"LRT station"/"station". */
  name: string;
  lat: number;
  lng: number;
  lines: string[];
  codes: string[];
  opening: string | null;
  states: string[];
  instances: string[];
  inUse: boolean;
  isMetro: boolean;
}

/** Wikidata line label / station code -> our line code. */
export function lineCodeFromWikidata(label: string): string | null {
  const s = label.toLowerCase().replace(/[–—-]/g, ' ');
  if (/north\s*south/.test(s)) return 'NSL';
  if (/east\s*west/.test(s)) return 'EWL';
  if (/north\s*east/.test(s)) return 'NEL';
  if (/circle/.test(s)) return 'CCL';
  if (/downtown/.test(s)) return 'DTL';
  if (/thomson/.test(s)) return 'TEL';
  if (/bukit panjang lrt/.test(s)) return 'BPLRT';
  if (/sengkang lrt/.test(s)) return 'SKLRT';
  if (/punggol lrt/.test(s)) return 'PGLRT';
  return null;
}
export function lineCodeFromStationCode(code: string): string | null {
  const m = /^([A-Z]{2,3})\d/.exec(code.trim().toUpperCase());
  if (!m) return null;
  const map: Record<string, string> = {
    NS: 'NSL', EW: 'EWL', CG: 'EWL', NE: 'NEL', CC: 'CCL', CE: 'CCL', DT: 'DTL', TE: 'TEL',
    BP: 'BPLRT', SE: 'SKLRT', SW: 'SKLRT', STC: 'SKLRT', PE: 'PGLRT', PW: 'PGLRT', PTC: 'PGLRT',
  };
  return map[m[1]!] ?? null;
}

export function stationName(label: string): string {
  return label.replace(/\s+(mrt\/lrt|mrt|lrt)?\s*station$/i, '').trim();
}

interface Binding {
  [k: string]: { value: string } | undefined;
}

export function processBindings(bindings: Binding[], today = new Date()): WikidataStation[] {
  const by = new Map<string, WikidataStation>();
  for (const b of bindings) {
    const qid = b['st']!.value.split('/').pop()!;
    let s = by.get(qid);
    if (!s) {
      const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b['coord']!.value);
      const label = b['stLabel']?.value ?? qid;
      s = {
        qid,
        label,
        name: stationName(label),
        lng: Number(m?.[1]),
        lat: Number(m?.[2]),
        lines: [],
        codes: [],
        opening: null,
        states: [],
        instances: [],
        inUse: false,
        isMetro: false,
      };
      by.set(qid, s);
    }
    const add = (arr: string[], v: string | undefined | null) => {
      if (v && !arr.includes(v)) arr.push(v);
    };
    const line = b['lineLabel']?.value;
    if (line) add(s.lines, lineCodeFromWikidata(line));
    const code = b['code']?.value;
    if (code) {
      add(s.codes, code);
      add(s.lines, lineCodeFromStationCode(code));
    }
    add(s.states, b['state']?.value.split('/').pop());
    add(s.instances, b['instLabel']?.value);
    const op = b['opening']?.value?.slice(0, 10);
    if (op && (!s.opening || op < s.opening)) s.opening = op;
  }
  const todayIso = today.toISOString().slice(0, 10);
  for (const s of by.values()) {
    s.lines.sort();
    s.codes.sort();
    s.states.sort();
    s.instances.sort();
    s.isMetro = s.lines.length > 0 || /\b(mrt|lrt)\b/i.test(s.label);
    const former = s.instances.some((i) => /former|closed|abandoned/i.test(i));
    s.inUse = s.states.length ? s.states.includes(IN_USE) : !former && !!s.opening && s.opening <= todayIso;
  }
  return [...by.values()].sort((a, b) => a.qid.localeCompare(b.qid, 'en', { numeric: true }));
}

const STATIONS_FILE = path.join(paths.wikidataRawDir, 'stations.json');

/** Singapore stations from Wikidata (CC0), cached at data/raw/wikidata/stations.json. */
export async function loadWikidataStations(mode: CacheMode = {}): Promise<WikidataStation[]> {
  const data = await cachedJson(
    STATIONS_FILE,
    async () => {
      const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(STATIONS_QUERY)}`;
      const json = await fetchJson<{ results: { bindings: Binding[] } }>(url, {
        headers: { Accept: 'application/sparql-results+json' },
        minIntervalMs: 1000,
        timeoutMs: 90_000,
      });
      return { fetchedAt: new Date().toISOString().slice(0, 10), licence: 'CC0 (Wikidata)', stations: processBindings(json.results.bindings) };
    },
    mode,
  );
  return (data as { stations: WikidataStation[] }).stations;
}

/** In-use MRT/LRT stations only. */
export async function loadActiveMetroStations(mode: CacheMode = {}): Promise<WikidataStation[]> {
  return (await loadWikidataStations(mode)).filter((s) => s.inUse && s.isMetro && Number.isFinite(s.lat));
}
