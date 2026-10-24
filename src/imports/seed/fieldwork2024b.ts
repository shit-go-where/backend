/**
 * `seed:fieldwork-2024b`: the expanded Aug-Oct 2024 survey (data/curated/fieldwork-2024b.json) into
 * venues / toilets / features / surveys with source FIELDWORK_2024_EXPANDED. Idempotent (a second run
 * changes nothing). Run after `seed:fieldwork`: survey2 rows can attach to pilot toilets.
 *
 * - Venues: survey2-venue-matches.json decides. A matched venue (pilot, Wikidata, data.gov.sg, OSM) is
 *   reused as it is, gets toiletStatus HAS_TOILETS and `externalIds.survey2Codes`; only its lines are
 *   unioned. A matched venue that is not in this DB yet (a fresh DB before import:wikidata/datagov/osm)
 *   and every "new" decision get a `survey2-venue:<CODE>` venue at our geocode.
 * - Toilets: a row attached to a pilot toilet creates no toilet: its survey goes on the pilot toilet and
 *   its features replace the pilot's where they are newer. Every other row is a `survey2:` toilet at its
 *   venue's coordinates. Features never overwrite COMMUNITY/ADMIN rows.
 * - OSM toilets the survey supersedes: import:osm's dedupe rule run the other way round. An ACTIVE OSM
 *   toilet at a venue with survey2 toilets, within 40 m of one, is deleted unless people have used it
 *   (reviews, check-ins, photos, status reports, flags, submissions, COMMUNITY/ADMIN features); logged
 *   as `osmSuperseded`. import:osm then skips it as a duplicate (findDuplicate counts both surveys).
 */
import type { DataSource, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import {
  loadFieldwork2024b,
  loadGeocoded,
  loadOverrides,
  loadSurvey2Matches,
  type FeatureName,
  type Survey2Toilet,
  type Survey2Venue,
} from '../curated/schema.js';
import { inSingapore } from '../lib/geo.js';
import { toJson, type RunCounts } from '../lib/importRun.js';
import { paths } from '../lib/paths.js';
import { levelFields } from '../../common/level.js';
import { findDuplicate, type ExistingToilet } from '../osm/tags.js';
import { haversineM } from '../lib/geo.js';
import { PROTECTED_SOURCES, same, sgDate, syncFeatures, syncSurveys, tally, type FeatureWant } from './fieldwork.js';

const SOURCE: DataSource = 'FIELDWORK_2024_EXPANDED';
/** The pilot (March 2024) row loses to an expanded (Aug-Oct) observation of the same toilet, and vice versa when newer. */
const NEWER_WINS: DataSource[] = ['FIELDWORK_2024'];

type VenueRow = Awaited<ReturnType<PrismaClient['venue']['findMany']>>[number];
type Ext = Record<string, unknown>;
const extOf = (v: { externalIds: unknown }): Ext => (v.externalIds as Ext | null) ?? {};
const asList = (x: unknown): string[] => (Array.isArray(x) ? (x as string[]) : typeof x === 'string' ? [x] : []);

/**
 * The DB venue a match points at: by sourceKey, else through the link another importer left when it
 * merged that record into an existing venue (externalIds.datagov.hawker / .wikidata / .osm).
 */
export function resolveVenue(sourceKey: string, venues: VenueRow[]): VenueRow | null {
  const own = venues.find((v) => v.sourceKey === sourceKey);
  if (own) return own;
  const [kind, id] = [sourceKey.slice(0, sourceKey.indexOf(':')), sourceKey.slice(sourceKey.indexOf(':') + 1)];
  if (kind === 'wikidata') return venues.find((v) => asList(extOf(v)['wikidata']).includes(id)) ?? null;
  if (kind.startsWith('datagov-')) {
    const ds = kind.slice('datagov-'.length);
    return venues.find((v) => asList((extOf(v)['datagov'] as Ext | undefined)?.[ds]).includes(id)) ?? null;
  }
  if (kind === 'osm-venue') return venues.find((v) => extOf(v)['osm'] === id && v.source === 'OSM') ?? null;
  return null;
}

/** One target toilet's wanted features: per feature, the newest row's observation. */
export function mergeWants(rows: Survey2Toilet[]): FeatureWant[] {
  const out = new Map<FeatureName, FeatureWant>();
  for (const r of [...rows].sort((a, b) => a.lastVerifiedAt.localeCompare(b.lastVerifiedAt))) {
    const observedAt = sgDate(r.lastVerifiedAt);
    for (const f of r.features) out.set(f.feature, { feature: f.feature, present: f.present, source: SOURCE, observedAt });
  }
  return [...out.values()].sort((a, b) => a.feature.localeCompare(b.feature));
}

/** Same radius as import:osm's dedupe. */
export const OSM_SUPERSEDE_RADIUS_M = 40;

interface OsmCandidate extends ExistingToilet {
  /** Reviews, check-ins, photos, …, COMMUNITY/ADMIN features: anything people added. */
  activity: number;
}

/**
 * The OSM toilets survey2 toilets supersede: findDuplicate (same venue, within 40 m, nearest) against the
 * survey2 toilets only. Touched ones are kept and listed, so a person's review never disappears.
 */
export function planOsmSupersede(osm: OsmCandidate[], survey2: ExistingToilet[], radiusM = OSM_SUPERSEDE_RADIUS_M) {
  const own = survey2.filter((t) => t.source === SOURCE);
  const remove: { osm: OsmCandidate; by: ExistingToilet; distanceM: number }[] = [];
  const keep: { osm: OsmCandidate; by: ExistingToilet }[] = [];
  for (const o of osm) {
    if (o.source !== 'OSM') continue;
    const by = findDuplicate(o, o.venueId, own, radiusM);
    if (!by) continue;
    if (o.activity > 0) keep.push({ osm: o, by });
    else remove.push({ osm: o, by, distanceM: Math.round(haversineM(o.lat, o.lng, by.lat, by.lng)) });
  }
  return { remove, keep };
}

export async function seedFieldwork2024b(db: PrismaClient): Promise<RunCounts & { log: Record<string, unknown> }> {
  const fw = loadFieldwork2024b();
  const matches = loadSurvey2Matches();
  if (!matches) throw new Error('No data/curated/survey2-venue-matches.json. Run `pnpm cli survey2:match`.');
  const geo = loadGeocoded(paths.survey2Geocoded);
  const overrides = loadOverrides();

  const noMatch = fw.venues.filter((v) => !matches.venues[v.key]);
  if (noMatch.length) throw new Error(`No match decision for ${noMatch.map((v) => v.key).join(', ')}. Run \`pnpm cli survey2:match\`.`);

  const venueT = { ...tally(), reused: 0, matchedButAbsent: [] as string[] };
  const toiletT = { ...tally(), attachedTo: 0, reopened: [] as string[] };
  const featT = { ...tally(), protected: 0, deleted: 0 };
  const surveyT = { ...tally(), deleted: 0 };

  // ── Venues
  const allVenues = await db.venue.findMany();
  const venueOf = new Map<string, { id: string; lat: number; lng: number }>();
  const createdFor = new Map<string, VenueRow>(); // unresolved existing key -> venue created this run
  for (const v of fw.venues) {
    const m = matches.venues[v.key]!;
    let target = m.existingVenueSourceKey ? resolveVenue(m.existingVenueSourceKey, allVenues) : null;
    if (m.existingVenueSourceKey && !target) target = createdFor.get(m.existingVenueSourceKey) ?? null;
    if (target && target.sourceKey !== `survey2-venue:${v.key}`) {
      await linkVenue(db, target, v, venueT);
      venueOf.set(v.key, { id: target.id, lat: target.latitude, lng: target.longitude });
      continue;
    }
    if (m.existingVenueSourceKey) venueT.matchedButAbsent.push(`${v.key} -> ${m.existingVenueSourceKey}`);
    const g = geo[v.key];
    if (!g || !inSingapore(g.lat, g.lng)) throw new Error(`survey2 venue ${v.key} is not geocoded / outside Singapore. Run \`pnpm cli geocode\`.`);
    const row = await upsertOwnVenue(db, v, g, overrides[v.key], allVenues, venueT);
    if (m.existingVenueSourceKey) createdFor.set(m.existingVenueSourceKey, row);
    venueOf.set(v.key, { id: row.id, lat: row.latitude, lng: row.longitude });
  }

  // ── Toilets: group rows by the DB toilet they end up on
  const own = fw.toilets.filter((t) => !matches.attach[t.sourceKey]?.pilotToiletSourceKey);
  const attached = fw.toilets.filter((t) => matches.attach[t.sourceKey]?.pilotToiletSourceKey);
  const pilotKeys = [...new Set(attached.map((t) => matches.attach[t.sourceKey]!.pilotToiletSourceKey!))];
  const existing = new Map(
    (
      await db.toilet.findMany({
        where: { sourceKey: { in: [...own.map((t) => t.sourceKey), ...pilotKeys] } },
        include: { features: true, surveys: true },
      })
    ).map((t) => [t.sourceKey, t]),
  );
  const missingPilot = pilotKeys.filter((k) => !existing.has(k));
  if (missingPilot.length) throw new Error(`Pilot toilets not in the DB: ${missingPilot.join(', ')}. Run \`pnpm cli seed:fieldwork\` first.`);

  for (const t of own) {
    const ex = existing.get(t.sourceKey);
    const c = venueOf.get(t.venueKey)!;
    const lv = sgDate(t.lastVerifiedAt);
    await db.$transaction(async (tx) => {
      let toiletId: string;
      if (!ex) {
        toiletId = (
          await tx.toilet.create({
            data: {
              venueId: c.id,
              label: t.label,
              latitude: c.lat,
              longitude: c.lng,
              ...levelFields(t.level),
              areaType: t.areaType,
              accessNote: t.accessNote,
              tier: t.tier,
              status: t.status,
              source: SOURCE,
              sourceKey: t.sourceKey,
              lastVerifiedAt: lv,
              needsResurvey: t.needsResurvey,
            },
          })
        ).id;
        toiletT.inserted++;
      } else {
        toiletId = ex.id;
        // Curated values only fill gaps (people may have corrected them since), as in seed:fieldwork.
        const data = {
          venueId: c.id,
          latitude: c.lat,
          longitude: c.lng,
          label: ex.label ?? t.label,
          ...levelFields(ex.level ?? t.level),
          accessNote: ex.accessNote ?? t.accessNote,
          lastVerifiedAt: ex.lastVerifiedAt && ex.lastVerifiedAt > lv ? ex.lastVerifiedAt : lv,
        };
        const cur = {
          venueId: ex.venueId,
          latitude: ex.latitude,
          longitude: ex.longitude,
          label: ex.label,
          level: ex.level,
          levelOrder: ex.levelOrder,
          accessNote: ex.accessNote,
          lastVerifiedAt: ex.lastVerifiedAt,
        };
        if (same(cur, data)) toiletT.unchanged++;
        else {
          await tx.toilet.update({ where: { id: ex.id }, data });
          toiletT.updated++;
        }
      }
      await syncFeatures(tx, toiletId, ex?.features ?? [], mergeWants([t]), SOURCE, featT, PROTECTED_SOURCES, NEWER_WINS);
      await syncSurveys(tx, toiletId, ex?.surveys ?? [], t.surveys, surveyT, SOURCE);
    });
  }

  for (const key of pilotKeys) {
    const ex = existing.get(key)!;
    const rows = attached.filter((t) => matches.attach[t.sourceKey]!.pilotToiletSourceKey === key);
    const newest = sgDate(rows.map((r) => r.lastVerifiedAt).sort().at(-1)!);
    await db.$transaction(async (tx) => {
      const data = {
        lastVerifiedAt: ex.lastVerifiedAt && ex.lastVerifiedAt > newest ? ex.lastVerifiedAt : newest,
        // Under renovation in March, surveyed in use in Aug-Oct.
        status: ex.status === 'RENOVATION' ? ('ACTIVE' as const) : ex.status,
      };
      if (ex.status === 'RENOVATION') toiletT.reopened.push(key);
      if (same({ lastVerifiedAt: ex.lastVerifiedAt, status: ex.status }, data)) toiletT.unchanged++;
      else {
        await tx.toilet.update({ where: { id: ex.id }, data });
        toiletT.updated++;
      }
      await syncFeatures(tx, ex.id, ex.features, mergeWants(rows), SOURCE, featT, PROTECTED_SOURCES, NEWER_WINS);
      await syncSurveys(tx, ex.id, ex.surveys, rows.flatMap((r) => r.surveys), surveyT, SOURCE);
    });
    toiletT.attachedTo++;
  }

  // ── OSM toilets beside survey2 toilets (import:osm only dedupes OSM toilets it has not imported yet)
  const ownRows = await db.toilet.findMany({
    where: { source: SOURCE, sourceKey: { startsWith: 'survey2:' }, status: 'ACTIVE' },
    select: { id: true, sourceKey: true, venueId: true, source: true, latitude: true, longitude: true },
  });
  const osmRows = await db.toilet.findMany({
    where: { source: 'OSM', status: 'ACTIVE', venueId: { in: [...new Set(ownRows.map((t) => t.venueId))] } },
    include: {
      venue: { select: { sourceKey: true } },
      features: { where: { source: { in: PROTECTED_SOURCES } }, select: { feature: true } },
      _count: { select: { reviews: true, statusReports: true, photos: true, checkIns: true, flags: true, submissions: true } },
    },
  });
  const plan = planOsmSupersede(
    osmRows.map((t) => ({
      id: t.id,
      sourceKey: t.sourceKey,
      venueId: t.venueId,
      source: t.source,
      lat: t.latitude,
      lng: t.longitude,
      activity: t.features.length + Object.values(t._count).reduce((a, n) => a + n, 0),
    })),
    ownRows.map((t) => ({ id: t.id, sourceKey: t.sourceKey, venueId: t.venueId, source: t.source, lat: t.latitude, lng: t.longitude })),
  );
  const venueKeyOf = new Map(osmRows.map((t) => [t.id, t.venue.sourceKey]));
  const osmSuperseded = plan.remove.map((r) => ({ osm: r.osm.sourceKey, survey2: r.by.sourceKey, venue: venueKeyOf.get(r.osm.id)!, distanceM: r.distanceM }));
  const osmKeptInUse = plan.keep.map((r) => ({ osm: r.osm.sourceKey, survey2: r.by.sourceKey, venue: venueKeyOf.get(r.osm.id)! }));
  if (plan.remove.length) await db.toilet.deleteMany({ where: { id: { in: plan.remove.map((r) => r.osm.id) } } });

  // ── survey2 toilets no longer in the curated file (e.g. a row now attached to a pilot toilet by hand)
  const ownKeys = new Set(own.map((t) => t.sourceKey));
  const stale = await db.toilet.findMany({
    where: { source: SOURCE, sourceKey: { startsWith: 'survey2:' }, NOT: { sourceKey: { in: [...ownKeys] } } },
    include: {
      features: { where: { source: { in: PROTECTED_SOURCES } } },
      _count: { select: { reviews: true, statusReports: true, photos: true, checkIns: true, flags: true, submissions: true } },
    },
  });
  const staleLog = { deleted: [] as string[], kept: [] as string[] };
  for (const s of stale) {
    const touched = s.features.length > 0 || Object.values(s._count).some((n) => n > 0);
    if (touched) staleLog.kept.push(s.sourceKey);
    else {
      await db.toilet.delete({ where: { id: s.id } });
      staleLog.deleted.push(s.sourceKey);
    }
  }

  const log = {
    venues: venueT,
    toilets: toiletT,
    features: featT,
    surveys: surveyT,
    staleToilets: staleLog,
    osmSuperseded,
    osmKeptInUse,
    rows: fw.toilets.length,
    ownToilets: own.length,
    rowsOnPilotToilets: attached.length,
  };
  console.log(JSON.stringify(log, null, 2));
  return {
    inserted: venueT.inserted + toiletT.inserted + featT.inserted + surveyT.inserted,
    updated: venueT.updated + toiletT.updated + featT.updated + surveyT.updated + featT.deleted + surveyT.deleted + staleLog.deleted.length + osmSuperseded.length,
    skipped: featT.protected,
    log,
  };
}

/** Reuse an existing venue: HAS_TOILETS, our codes in externalIds.survey2Codes, station lines unioned. Nothing else changes. */
async function linkVenue(db: PrismaClient, target: VenueRow, v: Survey2Venue, t: { updated: number; unchanged: number; reused: number }) {
  const ext = extOf(target);
  const codes = [...new Set([...asList(ext['survey2Codes']), v.code])].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const lines = [...target.lines, ...v.lines.filter((l) => !target.lines.includes(l))];
  const data = { toiletStatus: 'HAS_TOILETS' as const, externalIds: toJson({ ...ext, survey2Codes: codes }), lines };
  t.reused++;
  if (same({ toiletStatus: target.toiletStatus, externalIds: target.externalIds, lines: target.lines }, data)) {
    t.unchanged++;
    return;
  }
  Object.assign(target, await db.venue.update({ where: { id: target.id }, data }));
  t.updated++;
}

async function upsertOwnVenue(
  db: PrismaClient,
  v: Survey2Venue,
  g: ReturnType<typeof loadGeocoded>[string],
  ov: ReturnType<typeof loadOverrides>[string] | undefined,
  allVenues: VenueRow[],
  t: { inserted: number; updated: number; unchanged: number },
): Promise<VenueRow> {
  const ex = allVenues.find((x) => x.sourceKey === v.sourceKey);
  const ext = ex ? extOf(ex) : {};
  const codes = [...new Set([...asList(ext['survey2Codes']), v.code])].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const data: Prisma.VenueUncheckedUpdateInput & Prisma.VenueUncheckedCreateInput = {
    name: g.name ?? v.name,
    type: v.type,
    latitude: g.lat,
    longitude: g.lng,
    // The index's own address is the best we have; other importers (data.gov.sg) may fill a better one later.
    address: ov?.address ?? ex?.address ?? v.address ?? g.address,
    postalCode: ov?.postalCode ?? ex?.postalCode ?? v.postalCode ?? g.postalCode,
    planningArea: g.planningArea,
    lines: [...v.lines, ...(ex?.lines ?? []).filter((l) => !v.lines.includes(l))],
    toiletStatus: 'HAS_TOILETS',
    note: ex?.note ?? v.note,
    openingHours: v.openingHours ? toJson(v.openingHours) : undefined,
    source: SOURCE,
    sourceKey: v.sourceKey,
    externalIds: toJson({ ...ext, survey2Codes: codes }),
  };
  if (!ex) {
    const created = await db.venue.create({ data });
    allVenues.push(created);
    t.inserted++;
    return created;
  }
  const cur = {
    name: ex.name,
    type: ex.type,
    latitude: ex.latitude,
    longitude: ex.longitude,
    address: ex.address,
    postalCode: ex.postalCode,
    planningArea: ex.planningArea,
    lines: ex.lines,
    toiletStatus: ex.toiletStatus,
    note: ex.note,
    openingHours: ex.openingHours ?? undefined,
    source: ex.source,
    sourceKey: ex.sourceKey,
    externalIds: ex.externalIds,
  };
  if (same(cur, data)) {
    t.unchanged++;
    return ex;
  }
  const updated = await db.venue.update({ where: { id: ex.id }, data });
  Object.assign(ex, updated);
  t.updated++;
  return ex;
}
