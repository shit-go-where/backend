import path from 'node:path';
import fs from 'node:fs';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { loadOsmOverrides, type FeatureName } from '../curated/schema.js';
import { loadPlanningAreas } from '../geocode/planningArea.js';
import { readJson, writeJson } from '../lib/files.js';
import { haversineM, inSingapore, PointIndex } from '../lib/geo.js';
import { politeFetch, type CacheMode } from '../lib/http.js';
import { toJson, type RunCounts } from '../lib/importRun.js';
import { levelFields } from '../../common/level.js';
import { FIELDWORK_SOURCES, isFieldwork } from '../../common/sources.js';
import { paths } from '../lib/paths.js';
import { stableStringify, syncFeatures, tally, type FeatureWant } from '../seed/fieldwork.js';
import {
  accessOf,
  chooseVenue,
  elementLatLng,
  featuresFromTags,
  findDuplicate,
  findNearSurveyed,
  isGenericToiletVenue,
  isToiletsOnFeature,
  levelOf,
  OSM_ATTRIBUTION,
  openingHoursOf,
  osmSexes,
  survey2SexOf,
  venueNameFromTags,
  venueTypeFromTags,
  type ExistingToilet,
  type OsmElement,
  type SurveyedToilet,
  type VenueCandidate,
} from './tags.js';

export const OVERPASS_QUERY =
  '[out:json][timeout:120]; area["ISO3166-1"="SG"][admin_level=2]->.sg; (node["amenity"="toilets"](area.sg); way["amenity"="toilets"](area.sg); node["toilets"="yes"](area.sg); way["toilets"="yes"](area.sg);); out center tags;';
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const RAW_FILE = path.join(paths.osmRawDir, 'toilets.json');

interface OsmSnapshot {
  attribution: string;
  query: string;
  osmBase: string | null;
  elements: OsmElement[];
}

async function fetchOverpass(): Promise<OsmSnapshot> {
  let lastErr: unknown;
  for (const url of ENDPOINTS) {
    try {
      const res = await politeFetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: OVERPASS_QUERY }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        minIntervalMs: 2000,
        retries: 2,
        timeoutMs: 180_000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { osm3s?: { timestamp_osm_base?: string }; elements: OsmElement[] };
      if (!Array.isArray(j.elements)) throw new Error('no elements');
      console.log(`  Overpass ${url}: ${j.elements.length} elements`);
      return {
        attribution: OSM_ATTRIBUTION,
        query: OVERPASS_QUERY,
        osmBase: j.osm3s?.timestamp_osm_base ?? null,
        elements: j.elements
          .map((e) => ({ type: e.type, id: e.id, lat: e.lat, lon: e.lon, center: e.center, tags: e.tags }))
          .sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id),
      };
    } catch (err) {
      lastErr = err;
      console.warn(`  Overpass ${url} failed: ${(err as Error).message}`);
    }
  }
  throw lastErr;
}

async function loadSnapshot(mode: CacheMode): Promise<OsmSnapshot> {
  if (mode.offline || (!mode.refresh && fs.existsSync(RAW_FILE))) {
    if (!fs.existsSync(RAW_FILE)) throw new Error(`No cached OSM snapshot at ${RAW_FILE}`);
    return readJson<OsmSnapshot>(RAW_FILE);
  }
  try {
    const snap = await fetchOverpass();
    writeJson(RAW_FILE, snap);
    return snap;
  } catch (err) {
    if (fs.existsSync(RAW_FILE)) {
      console.warn(`  Overpass unavailable (${(err as Error).message}); using cached snapshot`);
      return readJson<OsmSnapshot>(RAW_FILE);
    }
    throw err;
  }
}

function addressFromTags(tags: Record<string, string>): string | null {
  const parts = [tags['addr:housenumber'], tags['addr:street'], tags['addr:postcode'] ? `Singapore ${tags['addr:postcode']}` : undefined].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

export async function importOsm(db: PrismaClient, opts: CacheMode & { close: boolean }): Promise<RunCounts & { log: Record<string, unknown> }> {
  const snap = await loadSnapshot(opts);
  const areas = await loadPlanningAreas({ offline: opts.offline });

  /** generic: the venue of a generic OSM toilet, not a place of its own (isGenericToiletVenue). */
  type V = VenueCandidate & { sourceKey: string; source: string; generic: boolean };
  const venues = await db.venue.findMany({
    select: { id: true, name: true, latitude: true, longitude: true, toiletStatus: true, sourceKey: true, source: true, type: true, externalIds: true },
  });
  const venueIndex = new PointIndex<V>();
  const venueById = new Map<string, V>();
  const venueByKey = new Map<string, V>();
  for (const v of venues) {
    const c: V = {
      id: v.id,
      name: v.name,
      lat: v.latitude,
      lng: v.longitude,
      toiletStatus: v.toiletStatus,
      sourceKey: v.sourceKey,
      source: v.source,
      generic: isGenericToiletVenue(v),
    };
    venueIndex.add(c);
    venueById.set(v.id, c);
    venueByKey.set(v.sourceKey, c);
  }
  const toilets = await db.toilet.findMany({
    select: { id: true, sourceKey: true, venueId: true, source: true, latitude: true, longitude: true, status: true, level: true },
  });
  const humanToilets: ExistingToilet[] = toilets
    .filter((t) => isFieldwork(t.source) || t.source === 'COMMUNITY')
    .map((t) => ({ id: t.id, sourceKey: t.sourceKey, venueId: t.venueId, source: t.source, lat: t.latitude, lng: t.longitude }));
  // Expanded-survey toilets for the cross-venue rule (findNearSurveyed). `placed`: no longer on its venue's point,
  // i.e. seed:fieldwork-2024b merged it onto an OSM toilet's position (or someone moved it).
  const surveyed: SurveyedToilet[] = toilets
    .filter((t) => t.source === 'FIELDWORK_2024_EXPANDED' && t.status === 'ACTIVE')
    .map((t) => {
      const v = venueById.get(t.venueId);
      return {
        id: t.id,
        sourceKey: t.sourceKey,
        venueId: t.venueId,
        source: t.source,
        lat: t.latitude,
        lng: t.longitude,
        level: t.level,
        sex: survey2SexOf(t.sourceKey),
        placed: !v || haversineM(t.latitude, t.longitude, v.lat, v.lng) >= 0.5,
      };
    });
  const overrides = loadOsmOverrides();
  const osmToilets = new Map(
    (
      await db.toilet.findMany({ where: { source: 'OSM' }, include: { features: true } })
    ).map((t) => [t.sourceKey, t]),
  );

  const venueT = tally();
  const toiletT = tally();
  const featT = { ...tally(), protected: 0, deleted: 0 };
  const skipped = { outside: 0, private: [] as string[], deduped: [] as { osm: string; matched: string; venue: string; rule: string }[] };
  const seen = new Set<string>();
  const now = new Date();

  for (const e of snap.elements) {
    const tags = e.tags ?? {};
    const sourceKey = `osm:${e.type}/${e.id}`;
    const ll = elementLatLng(e);
    if (!ll || !inSingapore(ll.lat, ll.lng)) {
      skipped.outside++;
      continue;
    }
    const access = accessOf(tags);
    if (access.skip) {
      skipped.private.push(sourceKey);
      continue;
    }
    seen.add(sourceKey);
    const existing = osmToilets.get(sourceKey);
    const onFeature = isToiletsOnFeature(tags);

    // 1. Venue: keep the existing link; else its own venue from an earlier run (the toilet may have been
    // superseded by a survey since: seed:fieldwork-2024b); else attach to a nearby venue; else create one.
    let venue: V | null = existing ? venueById.get(existing.venueId) ?? null : null;
    const ownVenueKey = `osm-venue:${e.type}/${e.id}`;
    if (!venue) venue = venueByKey.get(ownVenueKey) ?? null;
    if (!venue) {
      const near = venueIndex.near(ll.lat, ll.lng, 60).filter((c) => c.item.sourceKey !== ownVenueKey);
      venue = chooseVenue(ll, tags['name'], near, 60, onFeature) as V | null;
    }
    if (!venue || venue.sourceKey === ownVenueKey) {
      const data = {
        name: venueNameFromTags(tags),
        type: onFeature ? venueTypeFromTags(tags) : 'OTHER' as const,
        latitude: ll.lat,
        longitude: ll.lng,
        address: addressFromTags(tags),
        postalCode: tags['addr:postcode'] ?? null,
        planningArea: areas.lookup(ll.lat, ll.lng),
        toiletStatus: 'HAS_TOILETS' as const,
        openingHours: onFeature && openingHoursOf(tags) ? toJson(openingHoursOf(tags)) : undefined,
        source: 'OSM' as const,
        // osmKind 'toilet' = a generic toilet block (amenity=toilets) that data.gov.sg may later name.
        externalIds: toJson({ osm: `${e.type}/${e.id}`, osmKind: onFeature ? 'feature' : 'toilet' }),
      };
      const ex = await db.venue.findUnique({ where: { sourceKey: ownVenueKey } });
      let id: string;
      if (!ex) {
        id = (await db.venue.create({ data: { ...data, sourceKey: ownVenueKey } })).id;
        venueT.inserted++;
      } else {
        id = ex.id;
        const exExt = (ex.externalIds as Record<string, unknown> | null) ?? {};
        // Once data.gov.sg has claimed this venue (e.g. it is a hawker centre), keep its name/type/address.
        const claimed = !!exExt['datagov'];
        const upd = {
          ...data,
          ...(claimed ? { name: ex.name, type: ex.type, address: ex.address, postalCode: ex.postalCode } : {}),
          openingHours: data.openingHours ?? (ex.openingHours === null ? undefined : toJson(ex.openingHours)),
          toiletStatus: ex.toiletStatus === 'UNKNOWN' ? data.toiletStatus : ex.toiletStatus,
          externalIds: toJson({ ...exExt, osm: `${e.type}/${e.id}`, osmKind: onFeature ? 'feature' : 'toilet' }),
        };
        const cur = { name: ex.name, type: ex.type, latitude: ex.latitude, longitude: ex.longitude, address: ex.address, postalCode: ex.postalCode, planningArea: ex.planningArea, toiletStatus: ex.toiletStatus, openingHours: ex.openingHours ?? undefined, source: ex.source, externalIds: ex.externalIds };
        if (stableStringify(cur) !== stableStringify(upd)) {
          await db.venue.update({ where: { id }, data: upd });
          venueT.updated++;
        } else venueT.unchanged++;
      }
      if (!venue) {
        const generic = isGenericToiletVenue({ ...data, externalIds: ex?.externalIds ?? data.externalIds });
        venue = { id, name: data.name, lat: ll.lat, lng: ll.lng, toiletStatus: 'HAS_TOILETS', sourceKey: ownVenueKey, source: 'OSM', generic };
        venueIndex.add(venue);
        venueById.set(id, venue);
      }
    }
    // Dedupe also on the toilet's own OSM venue: a survey may have reused it (survey2:match) and
    // superseded this toilet (seed:fieldwork-2024b). A brand-new venue has no toilets, so no-op there.
    // Then across venues: the survey2 toilet merged onto this one's position, or the one in the same room
    // (the rules seed:fieldwork-2024b retires and merges by), and overrides.json osmOverrides.
    const ov = overrides[sourceKey];
    if (!existing && ov !== 'keep') {
      const dup = ov
        ? { sourceKey: ov === 'retire' ? 'overrides.json: retire' : ov.mergeInto, rule: 'override' }
        : (() => {
            const same = findDuplicate(ll, venue.id, humanToilets, 40);
            if (same) return { sourceKey: same.sourceKey, rule: 'same-venue-40m' };
            const point = { ...ll, level: levelFields(levelOf(tags)).level, sexes: osmSexes(featuresFromTags(tags)) };
            const hit = findNearSurveyed(point, venue.generic, surveyed);
            return hit && { sourceKey: hit.toilet.sourceKey, rule: hit.rule };
          })();
      if (dup) {
        skipped.deduped.push({ osm: sourceKey, matched: dup.sourceKey, venue: venue.sourceKey, rule: dup.rule });
        continue;
      }
    }
    if (venue.toiletStatus === 'UNKNOWN') {
      await db.venue.update({ where: { id: venue.id }, data: { toiletStatus: 'HAS_TOILETS' } });
      venue.toiletStatus = 'HAS_TOILETS';
      venueT.updated++;
    }

    // 2. Toilet
    const data = {
      venueId: venue.id,
      label: onFeature ? null : tags['name'] ?? null,
      latitude: ll.lat,
      longitude: ll.lng,
      ...levelFields(levelOf(tags)),
      accessNote: access.note,
      openingHours: !onFeature && openingHoursOf(tags) ? toJson(openingHoursOf(tags)) : undefined,
      tier: 'IMPORTED' as const,
      source: 'OSM' as const,
    };
    let toiletId: string;
    if (!existing) {
      toiletId = (await db.toilet.create({ data: { ...data, sourceKey, status: 'ACTIVE' } })).id;
      toiletT.inserted++;
    } else {
      toiletId = existing.id;
      const cur = {
        venueId: existing.venueId,
        label: existing.label,
        latitude: existing.latitude,
        longitude: existing.longitude,
        level: existing.level,
        levelOrder: existing.levelOrder,
        accessNote: existing.accessNote,
        openingHours: existing.openingHours ?? undefined,
        tier: existing.tier,
        source: existing.source,
      };
      const reopen = existing.status === 'CLOSED' && (existing.features.every((f) => f.source === 'OSM'));
      if (stableStringify(cur) !== stableStringify(data) || reopen) {
        await db.toilet.update({ where: { id: existing.id }, data: { ...data, ...(reopen ? { status: 'ACTIVE' as const } : {}) } });
        toiletT.updated++;
      } else toiletT.unchanged++;
    }

    // 3. Features (never overwrite FIELDWORK / COMMUNITY / ADMIN rows)
    const checkDate = /^\d{4}-\d{2}-\d{2}$/.test(tags['check_date'] ?? '') ? new Date(`${tags['check_date']}T00:00:00+08:00`) : null;
    const prev = new Map((existing?.features ?? []).map((f) => [f.feature, f]));
    const wants: FeatureWant[] = Object.entries(featuresFromTags(tags)).map(([feature, present]) => {
      const p = prev.get(feature as FeatureName);
      const observedAt = checkDate ?? (p && p.source === 'OSM' && p.present === present ? p.observedAt : now);
      return { feature: feature as FeatureName, present: present!, source: 'OSM', observedAt };
    });
    await db.$transaction(async (tx) =>
      syncFeatures(tx, toiletId, existing?.features ?? [], wants, 'OSM', featT, [...FIELDWORK_SOURCES, 'COMMUNITY', 'ADMIN']),
    );
  }

  // 4. Toilets gone from OSM -> CLOSED, unless people have touched them.
  const gone = [...osmToilets.values()].filter((t) => !seen.has(t.sourceKey) && t.status !== 'CLOSED');
  const closed: string[] = [];
  const keptTouched: string[] = [];
  const safe = seen.size >= osmToilets.size * 0.5;
  if (opts.close && safe) {
    for (const t of gone) {
      const touched =
        t.features.some((f) => f.source === 'COMMUNITY' || f.source === 'ADMIN') ||
        (await db.submission.count({ where: { toiletId: t.id } })) > 0;
      if (touched) {
        keptTouched.push(t.sourceKey);
        continue;
      }
      await db.toilet.update({ where: { id: t.id }, data: { status: 'CLOSED' } });
      closed.push(t.sourceKey);
    }
  }

  const log = {
    attribution: OSM_ATTRIBUTION,
    osmBase: snap.osmBase,
    elements: snap.elements.length,
    venues: venueT,
    toilets: toiletT,
    features: featT,
    skipped: { outsideBbox: skipped.outside, private: skipped.private.length, deduped: skipped.deduped.length },
    deduped: skipped.deduped,
    privateKeys: skipped.private,
    closed,
    keptTouched,
    closeSkippedUnsafe: opts.close && !safe ? gone.length : 0,
  };
  console.log(
    JSON.stringify({ ...log, deduped: `${skipped.deduped.length} (see ImportRun.log)`, privateKeys: undefined }, null, 2),
  );
  return {
    inserted: venueT.inserted + toiletT.inserted + featT.inserted,
    updated: venueT.updated + toiletT.updated + featT.updated + featT.deleted + closed.length,
    skipped: skipped.outside + skipped.private.length + skipped.deduped.length + featT.protected,
    log,
  };
}
