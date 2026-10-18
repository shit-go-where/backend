import path from 'node:path';
import type { PrismaClient, VenueType } from '../../generated/prisma/client.js';
import type { OpeningHours } from '../curated/schema.js';
import { loadPlanningAreas, titleCase } from '../geocode/planningArea.js';
import { cachedDatagovGeojson, DATAGOV_IDS, featureAttributes } from '../lib/datagov.js';
import { inSingapore, PointIndex } from '../lib/geo.js';
import type { CacheMode } from '../lib/http.js';
import { toJson, type RunCounts } from '../lib/importRun.js';
import { paths } from '../lib/paths.js';
import { nameKey, slugify } from '../lib/slug.js';
import { stableStringify } from '../seed/fieldwork.js';

export const DATAGOV_DATASET_NAMES = ['hawker', 'mrt-exits', 'cc', 'parks', 'libraries'] as const;
export type DatagovDatasetName = (typeof DATAGOV_DATASET_NAMES)[number];

export const DATAGOV_ATTRIBUTION =
  'Contains information from data.gov.sg datasets accessed under the Singapore Open Data Licence version 1.0 (https://data.gov.sg/open-data-licence)';

export const DATASETS: Record<DatagovDatasetName, { id: string; title: string; agency: string; file: string }> = {
  hawker: { id: DATAGOV_IDS.hawker, title: 'Hawker Centres (GEOJSON)', agency: 'NEA', file: 'hawker-centres.geojson' },
  'mrt-exits': { id: DATAGOV_IDS.mrtExits, title: 'LTA MRT Station Exit (GEOJSON)', agency: 'LTA', file: 'lta-mrt-station-exits.geojson' },
  cc: { id: DATAGOV_IDS.communityClubs, title: 'Community Clubs', agency: 'PA', file: 'community-clubs.geojson' },
  parks: { id: DATAGOV_IDS.parks, title: 'Parks', agency: 'NParks', file: 'parks.geojson' },
  libraries: { id: DATAGOV_IDS.libraries, title: 'Libraries', agency: 'NLB', file: 'libraries.geojson' },
};

interface Fc {
  features: { properties: Record<string, unknown>; geometry: { type: string; coordinates: number[] } | null }[];
}

const daily = (open: string, close: string): OpeningHours => ({
  type: 'weekly',
  periods: [{ days: [0, 1, 2, 3, 4, 5, 6], open, close }],
  inferred: true,
});

/** "JLN KEBAYA PK" -> "Jalan Kebaya Park". */
export function expandParkName(raw: string): string {
  const map: Record<string, string> = {
    JLN: 'Jalan', LOR: 'Lorong', RD: 'Road', AVE: 'Avenue', DR: 'Drive', ST: 'Street', PK: 'Park', CRES: 'Crescent',
    GDN: 'Garden', GDNS: 'Gardens', CL: 'Close', PL: 'Place', TER: 'Terrace', UPP: 'Upper', NTH: 'North', STH: 'South',
    CTRL: 'Central', CTR: 'Centre', OS: 'Open Space', PG: 'Playground', FC: 'Fitness Corner', BT: 'Bukit', TG: 'Tanjong',
    KG: 'Kampong', HTS: 'Heights', PCN: 'Park Connector', NP: 'Nature Park',
  };
  return raw
    .split(/\s+/)
    .map((w) => {
      const bare = w.replace(/[^A-Z]/gi, '').toUpperCase();
      if (map[bare]) return w.toUpperCase().replace(bare, map[bare]!);
      if (/^\(.*\)$/.test(w) || /^[IVX]+$/.test(w)) return w;
      return titleCase(w);
    })
    .join(' ');
}

/** NParks "Parks" includes playgrounds, open spaces and fitness corners: those rarely have toilets. */
export function isMinorParkSpace(name: string): boolean {
  return /\b(PG|PLAYGROUND|OS|FC|FITNESS CORNER|FOOTBALL FIELD|COURT)\b(\s+[IVX]+)?$/i.test(name.trim());
}

/** Comparison key that treats "CC" and "Community Club" as the same. */
const cmpName = (s: string) => nameKey(s.replace(/\bCC\b/gi, ' community club ').replace(/\bcentre\b/gi, 'center'));
export const sameish = (a: string, b: string) => {
  const x = cmpName(a);
  const y = cmpName(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

interface ShellInput {
  ds: DatagovDatasetName;
  id: string;
  name: string;
  type: VenueType;
  lat: number;
  lng: number;
  address: string | null;
  postalCode: string | null;
  openingHours: OpeningHours | null;
}

type VenueRow = Awaited<ReturnType<PrismaClient['venue']['findMany']>>[number];

/** OSM-created venue around a bare amenity=toilets (not a shop/restaurant with toilets=yes). */
export function isGenericOsmToiletVenue(v: { source: string; type: string; externalIds: unknown }): boolean {
  return v.source === 'OSM' && v.type === 'OTHER' && (v.externalIds as { osmKind?: string } | null)?.osmKind === 'toilet';
}
type Indexed = { lat: number; lng: number; v: VenueRow };

export async function importDatagov(
  db: PrismaClient,
  names: DatagovDatasetName[],
  mode: CacheMode,
): Promise<RunCounts & { log: Record<string, unknown> }> {
  const areas = await loadPlanningAreas({ offline: mode.offline });
  const venues = await db.venue.findMany();
  const venueIndex = new PointIndex<Indexed>();
  for (const v of venues) venueIndex.add({ lat: v.latitude, lng: v.longitude, v });
  const toilets = await db.toilet.findMany({ select: { latitude: true, longitude: true, venueId: true }, where: { status: { not: 'REJECTED' } } });
  const toiletIndex = new PointIndex<{ lat: number; lng: number; venueId: string }>();
  for (const t of toilets) toiletIndex.add({ lat: t.latitude, lng: t.longitude, venueId: t.venueId });
  const venueById = new Map(venues.map((v) => [v.id, v]));

  const counts = { inserted: 0, updated: 0, skipped: 0 };
  const log: Record<string, unknown> = { attribution: DATAGOV_ATTRIBUTION };

  const upsertShell = async (s: ShellInput, stats: Record<string, number>) => {
    const sourceKey = `datagov-${s.ds}:${s.id}`;
    const ext = (v: VenueRow) => (v.externalIds as Record<string, unknown> | null) ?? {};
    // externalIds.datagov.<dataset> = [ids]: several dataset points can merge into one venue.
    const linksOf = (v: VenueRow): string[] => {
      const x = (ext(v)['datagov'] as Record<string, unknown> | undefined)?.[s.ds];
      return Array.isArray(x) ? (x as string[]) : typeof x === 'string' ? [x] : [];
    };
    let target = venues.find((v) => v.sourceKey === sourceKey) ?? venues.find((v) => linksOf(v).includes(s.id));
    let how = target ? (target.sourceKey === sourceKey ? 'own' : 'linked') : '';
    if (!target) {
      // Merge into an existing venue of the same kind: same type (or a generic OSM venue) nearby.
      const near = venueIndex.near(s.lat, s.lng, 300).filter(
        ({ item, distanceM }) =>
          !item.v.sourceKey.startsWith(`datagov-${s.ds}:`) &&
          (item.v.type === s.type || isGenericOsmToiletVenue(item.v)) &&
          (distanceM <= 60 || (distanceM <= 300 && sameish(item.v.name, s.name))),
      );
      const named = near.find((n) => sameish(n.item.v.name, s.name));
      target = (named ?? near.find((n) => n.distanceM <= 60))?.item.v;
      how = target ? 'merged' : '';
    }
    if (!target && s.ds === 'hawker') {
      // A toilet within 60 m whose venue is a hawker centre or a generic OSM toilet venue.
      const t = toiletIndex
        .near(s.lat, s.lng, 60)
        .map((x) => venueById.get(x.item.venueId)!)
        .find((v) => v && (v.type === 'HAWKER_CENTRE' || isGenericOsmToiletVenue(v)));
      if (t) {
        target = t;
        how = 'merged-by-toilet';
      }
    }
    if (target && how !== 'own') {
      // Link: remember the dataset id, fill address gaps; never rename/retype someone else's venue.
      const ids = [...new Set([...linksOf(target), s.id])].sort();
      const externalIds = { ...ext(target), datagov: { ...((ext(target)['datagov'] as object) ?? {}), [s.ds]: ids } };
      // Hawker centres: NEA's address is authoritative, so it replaces the venue's address — unless
      // several dataset points share this venue (then only fill gaps, or they would flip-flop).
      const authoritative = s.ds === 'hawker' && ids.length === 1;
      // A generic OSM toilet block ("Public toilet") takes the dataset's identity: it *is* the hawker centre / CC.
      const upgrade = isGenericOsmToiletVenue(target)
        ? { name: s.name, type: s.type, ...(s.openingHours ? { openingHours: toJson(s.openingHours) } : {}) }
        : {};
      const data = {
        ...upgrade,
        externalIds: toJson(externalIds),
        address: authoritative ? s.address ?? target.address : target.address ?? s.address,
        postalCode: authoritative ? s.postalCode ?? target.postalCode : target.postalCode ?? s.postalCode,
      };
      const cur = {
        ...(isGenericOsmToiletVenue(target)
          ? { name: target.name, type: target.type, ...(s.openingHours ? { openingHours: target.openingHours } : {}) }
          : {}),
        externalIds: target.externalIds,
        address: target.address,
        postalCode: target.postalCode,
      };
      if (stableStringify(cur) !== stableStringify(data)) {
        const updated = await db.venue.update({ where: { id: target.id }, data });
        Object.assign(target, updated);
        counts.updated++;
        stats['linkedUpdated'] = (stats['linkedUpdated'] ?? 0) + 1;
      } else stats['linkedUnchanged'] = (stats['linkedUnchanged'] ?? 0) + 1;
      stats[how] = (stats[how] ?? 0) + 1;
      return;
    }
    const data = {
      name: s.name,
      type: s.type,
      latitude: s.lat,
      longitude: s.lng,
      address: s.address,
      postalCode: s.postalCode,
      planningArea: areas.lookup(s.lat, s.lng),
      openingHours: s.openingHours ? toJson(s.openingHours) : undefined,
      source: 'DATAGOV' as const,
      externalIds: toJson({ ...((target?.externalIds as object) ?? {}), datagov: { [s.ds]: [s.id] } }),
    };
    if (!target) {
      const created = await db.venue.create({ data: { ...data, sourceKey, toiletStatus: 'UNKNOWN' } });
      venues.push(created);
      venueById.set(created.id, created);
      venueIndex.add({ lat: created.latitude, lng: created.longitude, v: created });
      counts.inserted++;
      stats['created'] = (stats['created'] ?? 0) + 1;
      return;
    }
    const cur = {
      name: target.name, type: target.type, latitude: target.latitude, longitude: target.longitude, address: target.address,
      postalCode: target.postalCode, planningArea: target.planningArea, openingHours: target.openingHours ?? undefined,
      source: target.source, externalIds: target.externalIds,
    };
    if (stableStringify(cur) !== stableStringify(data)) {
      Object.assign(target, await db.venue.update({ where: { id: target.id }, data }));
      counts.updated++;
      stats['ownUpdated'] = (stats['ownUpdated'] ?? 0) + 1;
    } else stats['ownUnchanged'] = (stats['ownUnchanged'] ?? 0) + 1;
  };

  const seenIds = new Map<string, number>();
  const uniqueId = (ds: string, base: string) => {
    const k = `${ds}:${base}`;
    const n = (seenIds.get(k) ?? 0) + 1;
    seenIds.set(k, n);
    return n === 1 ? base : `${base}-${n}`;
  };

  for (const name of names) {
    const meta = DATASETS[name];
    const file = path.join(paths.datagovRawDir, meta.file);
    let fc: Fc;
    try {
      fc = await cachedDatagovGeojson<Fc>(meta.id, file, mode);
    } catch (err) {
      console.warn(`  ${name}: dataset unavailable (${(err as Error).message}); skipping`);
      log[name] = { datasetId: meta.id, error: (err as Error).message };
      continue;
    }
    const stats: Record<string, number> = { features: fc.features.length };
    const pts = fc.features
      .map((f) => {
        const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : null;
        return { a: featureAttributes(f.properties), lat: c?.[1] ?? NaN, lng: c?.[0] ?? NaN };
      })
      .filter((p) => {
        const ok = inSingapore(p.lat, p.lng);
        if (!ok) stats['outsideBbox'] = (stats['outsideBbox'] ?? 0) + 1;
        return ok;
      })
      .sort((x, y) => (x.a['NAME'] ?? x.a['STATION_NA'] ?? '').localeCompare(y.a['NAME'] ?? y.a['STATION_NA'] ?? '') || x.lat - y.lat);

    if (name === 'mrt-exits') {
      await importExits(db, venues, pts, stats, counts);
    } else {
      for (const p of pts) {
        const a = p.a;
        const raw = a['NAME'] ?? '';
        if (!raw) {
          stats['noName'] = (stats['noName'] ?? 0) + 1;
          continue;
        }
        if (name === 'hawker' && /under construction/i.test(a['STATUS'] ?? '')) {
          stats['underConstruction'] = (stats['underConstruction'] ?? 0) + 1;
          counts.skipped++;
          continue;
        }
        if (name === 'parks' && isMinorParkSpace(raw)) {
          stats['minorSpaceSkipped'] = (stats['minorSpaceSkipped'] ?? 0) + 1;
          counts.skipped++;
          continue;
        }
        const display = name === 'parks' ? expandParkName(raw) : name === 'cc' ? raw.replace(/\bCC$/, 'Community Club') : raw;
        const street = [a['ADDRESSBLOCKHOUSENUMBER'], a['ADDRESSSTREETNAME']].filter(Boolean).join(' ');
        const postal = a['ADDRESSPOSTALCODE'] || null;
        const address = a['ADDRESS_MYENV'] || (street ? `${street}${postal ? `, Singapore ${postal}` : ''}` : null);
        const type: VenueType = { hawker: 'HAWKER_CENTRE', cc: 'COMMUNITY_CLUB', parks: 'PARK', libraries: 'LIBRARY' }[name] as VenueType;
        const hours = name === 'hawker' ? daily('06:00', '22:00') : name === 'cc' ? daily('09:00', '22:00') : name === 'libraries' ? daily('10:00', '21:00') : null;
        await upsertShell(
          { ds: name, id: uniqueId(name, slugify(raw)), name: display, type, lat: p.lat, lng: p.lng, address, postalCode: postal, openingHours: hours },
          stats,
        );
      }
    }
    log[name] = { datasetId: meta.id, title: `${meta.title} (${meta.agency})`, file: `data/raw/datagov/${meta.file}`, ...stats };
    console.log(`  ${name}: ${JSON.stringify(stats)}`);
  }
  return { ...counts, log };
}

async function importExits(
  db: PrismaClient,
  venues: VenueRow[],
  pts: { a: Record<string, string>; lat: number; lng: number }[],
  stats: Record<string, number>,
  counts: RunCounts,
): Promise<void> {
  const byStation = new Map<string, { exit: string; lat: number; lng: number }[]>();
  for (const p of pts) {
    const st = (p.a['STATION_NA'] ?? '').replace(/\s+(MRT|LRT)\s+STATION$/i, '').trim();
    if (!st) continue;
    const k = nameKey(st);
    const list = byStation.get(k) ?? [];
    list.push({ exit: (p.a['EXIT_CODE'] ?? '').trim(), lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6 });
    byStation.set(k, list);
  }
  const mrt = venues.filter((v) => v.type === 'MRT_STATION');
  const unmatched: string[] = [];
  const perVenue = new Map<string, { v: VenueRow; exits: { exit: string; lat: number; lng: number }[] }>();
  for (const [k, exits] of [...byStation].sort()) {
    // A few new stations are listed by code only ("CC30", "NE18"): match those on Wikidata codes.
    const isCode = /^[a-z]{2,3}\s?\d+$/.test(k);
    const v = isCode
      ? mrt.find((x) => ((x.externalIds as { codes?: string[] } | null)?.codes ?? []).includes(k.replace(/\s/g, '').toUpperCase()))
      : mrt.find((x) => nameKey(x.name) === k);
    if (!v) {
      unmatched.push(k);
      continue;
    }
    const entry = perVenue.get(v.id) ?? { v, exits: [] };
    entry.exits.push(...exits);
    perVenue.set(v.id, entry);
  }
  for (const { v, exits: all } of perVenue.values()) {
    const seen = new Set<string>();
    const exits = all
      .filter((x) => {
        const key = `${x.exit}|${x.lat}|${x.lng}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((x, y) => x.exit.localeCompare(y.exit, 'en', { numeric: true }) || x.lat - y.lat || x.lng - y.lng);
    const ext = (v.externalIds as Record<string, unknown> | null) ?? {};
    if (stableStringify(ext['exits']) === stableStringify(exits)) {
      stats['unchanged'] = (stats['unchanged'] ?? 0) + 1;
      continue;
    }
    Object.assign(v, await db.venue.update({ where: { id: v.id }, data: { externalIds: toJson({ ...ext, exits }) } }));
    counts.updated++;
    stats['stationsUpdated'] = (stats['stationsUpdated'] ?? 0) + 1;
  }
  stats['stationsInDataset'] = byStation.size;
  stats['stationsUnmatched'] = unmatched.length;
  if (unmatched.length) console.log(`  mrt-exits: no venue for ${unmatched.join(', ')}`);
}
