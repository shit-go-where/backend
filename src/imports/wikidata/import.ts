import type { PrismaClient } from '../../generated/prisma/client.js';
import { loadPlanningAreas } from '../geocode/planningArea.js';
import { INFERRED_HOURS } from '../sheet/normalise.js';
import { haversineM } from '../lib/geo.js';
import type { CacheMode } from '../lib/http.js';
import { toJson, type RunCounts } from '../lib/importRun.js';
import { nameKey } from '../lib/slug.js';
import { stableStringify } from '../seed/fieldwork.js';
import { loadActiveMetroStations } from './stations.js';

export const WIKIDATA_ATTRIBUTION = 'Station data from Wikidata (CC0 1.0)';

/** Stations further than this from a same-name venue are treated as different places. */
const SAME_NAME_MAX_M = 1500;

export async function importWikidata(db: PrismaClient, mode: CacheMode): Promise<RunCounts & { log: Record<string, unknown> }> {
  const stations = await loadActiveMetroStations(mode);
  const areas = await loadPlanningAreas({ offline: mode.offline });
  const venues = await db.venue.findMany({ where: { type: 'MRT_STATION' } });
  const counts = { inserted: 0, updated: 0, skipped: 0 };
  const added: string[] = [];
  const linesFilled: string[] = [];
  let linked = 0;
  let unchanged = 0;

  for (const s of stations) {
    const k = nameKey(s.name);
    const match = venues.find((v) => nameKey(v.name) === k && haversineM(v.latitude, v.longitude, s.lat, s.lng) < SAME_NAME_MAX_M);
    if (match) {
      const ext = (match.externalIds as Record<string, unknown> | null) ?? {};
      const asList = (x: unknown) => (Array.isArray(x) ? (x as string[]) : typeof x === 'string' ? [x] : []);
      const qids = [...new Set([...asList(ext['wikidata']), s.qid])].sort();
      const codes = [...new Set([...asList(ext['codes']), ...s.codes])].sort();
      const data = {
        externalIds: toJson({ ...ext, wikidata: qids, ...(codes.length ? { codes } : {}) }),
        // Only fill lines when we know none (e.g. renovation-only stations from the sheet).
        lines: match.lines.length ? match.lines : s.lines,
      };
      if (stableStringify({ externalIds: match.externalIds, lines: match.lines }) === stableStringify(data)) {
        unchanged++;
        continue;
      }
      if (!match.lines.length && s.lines.length) linesFilled.push(match.name);
      Object.assign(match, await db.venue.update({ where: { id: match.id }, data }));
      counts.updated++;
      linked++;
      continue;
    }
    const created = await db.venue.create({
      data: {
        name: s.name,
        type: 'MRT_STATION',
        latitude: s.lat,
        longitude: s.lng,
        planningArea: areas.lookup(s.lat, s.lng),
        lines: s.lines,
        toiletStatus: 'UNKNOWN',
        openingHours: toJson(INFERRED_HOURS.MRT_STATION),
        source: 'WIKIDATA',
        sourceKey: `wikidata:${s.qid}`,
        externalIds: toJson({ wikidata: [s.qid], codes: s.codes, opened: s.opening }),
      },
    });
    venues.push(created);
    added.push(`${s.name} (${s.qid}${s.opening ? `, opened ${s.opening}` : ''})`);
    counts.inserted++;
  }
  const log = {
    attribution: WIKIDATA_ATTRIBUTION,
    activeStations: stations.length,
    added,
    linesFilled,
    linkedOrUpdated: linked,
    unchanged,
  };
  console.log(JSON.stringify(log, null, 2));
  return { ...counts, log };
}
