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
 * - OSM toilets at other venues (planOsmNear): overrides.json `osmOverrides` first; then an OSM toilet with a
 *   level inside a surveyed building gives the survey2 toilet(s) on that level its position (`osmMerged`) and
 *   is deleted; a generic OSM toilet in the same room as a survey2 toilet is deleted (`osmSuperseded`, rule
 *   near-15m). The rest within 45 m go to review.json `survey2OsmNear`. import:osm skips all of these
 *   (findNearSurveyed). A survey2 toilet off its venue's point keeps that position on later runs.
 */
import type { DataSource, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import {
  loadFieldwork2024b,
  loadGeocoded,
  loadOsmOverrides,
  loadOverrides,
  loadReview,
  loadSurvey2Matches,
  type OsmOverrides,
  type ReviewItem,
  type FeatureName,
  type Survey2Toilet,
  type Survey2Venue,
} from '../curated/schema.js';
import { writeJson } from '../lib/files.js';
import { inSingapore, PointIndex } from '../lib/geo.js';
import { toJson, type RunCounts } from '../lib/importRun.js';
import { paths } from '../lib/paths.js';
import { levelFields } from '../../common/level.js';
import {
  findDuplicate,
  findNearSurveyed,
  isGenericToiletVenue,
  NEAR_SURVEY_RADIUS_M,
  survey2SexOf,
  type ExistingToilet,
  type SurveyedToilet,
  type ToiletSex,
} from '../osm/tags.js';
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

/** A toilet this close to its venue's point is "at the venue" (survey2 toilets are created there). */
const AT_POINT_M = 0.5;
const atPoint = (t: { latitude: number; longitude: number }, p: { lat: number; lng: number }) => haversineM(t.latitude, t.longitude, p.lat, p.lng) < AT_POINT_M;

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

/** An OSM toilet within this distance of a survey2 venue's point can be merged onto one of its toilets by floor. */
export const OSM_MERGE_RADIUS_M = 60;
/** Kept OSM toilets closer than this to a survey2 toilet are listed in review.json (`survey2OsmNear`). */
export const OSM_NEAR_REVIEW_M = 45;
/** A single normalised level ("B1", "L3", "M"); "L1; L2" spans floors and cannot pick one toilet. */
const ONE_LEVEL = /^(?:B\d+|L\d+|M)$/;
const ALL_SEXES: ToiletSex[] = ['MALE', 'FEMALE', 'UNISEX'];

export interface OsmNearCandidate extends OsmCandidate {
  /** Normalised level, or null. */
  level: string | null;
  /** Sexes the OSM toilet is tagged for; empty = untagged (a block with all of them). */
  sexes: ToiletSex[];
  /** Its venue is not a place of its own (isGenericToiletVenue). */
  generic: boolean;
}

export interface OsmNearPlan {
  /** Survey2 toilets that move onto the OSM toilet's coordinates; the OSM toilet is deleted. */
  merged: { osm: OsmNearCandidate; into: SurveyedToilet[]; distanceM: number; rule: 'floor' | 'override' }[];
  retired: { osm: OsmNearCandidate; by: SurveyedToilet | null; distanceM: number | null; rule: 'near-15m' | 'merged-position' | 'override' }[];
  /** Would have been merged or retired, but people have used it. */
  keptInUse: { osm: OsmNearCandidate; by: SurveyedToilet | null; rule: string }[];
  ambiguous: { venueId: string; level: string; osm: string[]; survey2: string[]; reason: string }[];
  /** Everything else within OSM_NEAR_REVIEW_M of a survey2 toilet, with why it stays. */
  near: { osm: OsmNearCandidate; by: SurveyedToilet; distanceM: number; reason: string }[];
  unusedOverrides: { key: string; reason: string }[];
}

/**
 * OSM toilets next to survey2 toilets at other venues (planOsmSupersede only looks at the same venue), in order:
 *
 * 1. overrides.json `osmOverrides` ("retire", "keep", `{ mergeInto }`), before any rule.
 * 2. Merge by floor: an OSM toilet with one normalised level, within 60 m of a survey2 venue's point (the nearest
 *    such venue), on a generic venue or that same venue. Its sex tag picks the survey2 toilet of that sex on that
 *    level; untagged, it takes one per sex. Those survey2 toilets move onto its coordinates. A level where a sex has
 *    several survey2 toilets (wings), several OSM toilets claim one sex, or the survey2 toilet already has its own
 *    position is left alone and listed as ambiguous.
 * 3. Retire a generic OSM toilet that is the same room as a survey2 toilet (findNearSurveyed, against the positions
 *    after step 2; the same rule import:osm dedupes with).
 *
 * Toilets people have used are never merged or retired (keptInUse). `survey2Venues` maps venue id -> its point.
 */
export function planOsmNear(
  osm: OsmNearCandidate[],
  survey2: SurveyedToilet[],
  survey2Venues: Map<string, { lat: number; lng: number }>,
  overrides: OsmOverrides = {},
): OsmNearPlan {
  // Copies: merges move them, and step 3 must see where they ended up.
  const s2 = survey2.filter((t) => t.source === SOURCE).map((t) => ({ ...t }));
  const s2ByKey = new Map(s2.map((t) => [t.sourceKey, t]));
  const plan: OsmNearPlan = { merged: [], retired: [], keptInUse: [], ambiguous: [], near: [], unusedOverrides: [] };
  const decided = new Set<string>();
  const why = new Map<string, string>(); // osm key -> reason it stays (for the near list)
  const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => haversineM(a.lat, a.lng, b.lat, b.lng);
  const origin = (t: SurveyedToilet) => (t.placed ? t : survey2Venues.get(t.venueId) ?? t);
  const move = (o: OsmNearCandidate, into: SurveyedToilet[], rule: 'floor' | 'override') => {
    plan.merged.push({ osm: o, into: into.map((t) => ({ ...t })), distanceM: Math.round(Math.min(...into.map((t) => dist(o, origin(t))))), rule });
    for (const t of into) Object.assign(t, { lat: o.lat, lng: o.lng, placed: true });
  };
  const nearest = (o: OsmNearCandidate) =>
    s2.map((t) => ({ t, d: dist(o, t) })).reduce<{ t: SurveyedToilet; d: number } | null>((b, x) => (!b || x.d < b.d ? x : b), null);

  // 1. Overrides
  const present = new Set(osm.map((o) => o.sourceKey));
  for (const key of Object.keys(overrides).sort())
    if (!present.has(key)) plan.unusedOverrides.push({ key, reason: 'no ACTIVE OSM toilet with this key near a survey2 toilet (already retired or merged, or not imported)' });
  for (const o of osm) {
    const ov = overrides[o.sourceKey];
    if (!ov) continue;
    decided.add(o.sourceKey);
    if (ov === 'keep') {
      why.set(o.sourceKey, 'overrides.json: keep');
      continue;
    }
    if (o.activity > 0) {
      plan.keptInUse.push({ osm: o, by: ov === 'retire' ? nearest(o)?.t ?? null : s2ByKey.get(ov.mergeInto) ?? null, rule: 'override' });
      why.set(o.sourceKey, 'in use (overrides.json not applied)');
      continue;
    }
    if (ov === 'retire') {
      const n = nearest(o);
      plan.retired.push({ osm: o, by: n?.t ?? null, distanceM: n ? Math.round(n.d) : null, rule: 'override' });
      continue;
    }
    const target = s2ByKey.get(ov.mergeInto);
    if (!target || plan.merged.some((m) => m.into.some((t) => t.sourceKey === ov.mergeInto))) {
      plan.unusedOverrides.push({ key: o.sourceKey, reason: target ? `mergeInto ${ov.mergeInto}: already merged with another OSM toilet` : `mergeInto ${ov.mergeInto}: no such ACTIVE survey2 toilet` });
      why.set(o.sourceKey, 'overrides.json mergeInto not applied');
      continue;
    }
    move(o, [target], 'override');
  }

  // 2. Merge by floor
  const groups = new Map<string, { venueId: string; level: string; osm: OsmNearCandidate[] }>();
  for (const o of osm) {
    if (decided.has(o.sourceKey) || !o.level || !ONE_LEVEL.test(o.level)) continue;
    let venue: { id: string; d: number } | null = null;
    for (const [id, p] of survey2Venues) {
      const d = dist(o, p);
      if (d <= OSM_MERGE_RADIUS_M && (!venue || d < venue.d)) venue = { id, d };
    }
    // A named place of its own next door (a library in the mall) keeps its toilet.
    if (!venue || (!o.generic && o.venueId !== venue.id)) continue;
    const k = `${venue.id}|${o.level}`;
    const g = groups.get(k) ?? { venueId: venue.id, level: o.level, osm: [] };
    g.osm.push(o);
    groups.set(k, g);
  }
  const ambiguousOsm = new Set<string>();
  for (const g of groups.values()) {
    const onLevel = s2.filter((t) => t.venueId === g.venueId && t.level === g.level);
    const ofSex = (sex: ToiletSex) => onLevel.filter((t) => t.sex === sex);
    const wants = (o: OsmNearCandidate) => (o.sexes.length ? o.sexes : ALL_SEXES).filter((sex) => ofSex(sex).length > 0);
    const problems: string[] = [];
    for (const sex of ALL_SEXES) {
      const claimants = g.osm.filter((o) => wants(o).includes(sex));
      if (!claimants.length) continue;
      if (ofSex(sex).length > 1) problems.push(`${ofSex(sex).length} ${sex} survey2 toilets on ${g.level}`);
      if (claimants.length > 1) problems.push(`${claimants.length} OSM toilets for ${sex} on ${g.level}`);
      const placed = ofSex(sex).filter((t) => t.placed);
      if (placed.length) problems.push(`${placed.map((t) => t.sourceKey).join(', ')} already has its own position`);
    }
    if (problems.length) {
      plan.ambiguous.push({ venueId: g.venueId, level: g.level, osm: g.osm.map((o) => o.sourceKey).sort(), survey2: onLevel.map((t) => t.sourceKey).sort(), reason: problems.join('; ') });
      for (const o of g.osm) {
        ambiguousOsm.add(o.sourceKey);
        why.set(o.sourceKey, `floor merge ambiguous: ${problems.join('; ')}`);
      }
      continue;
    }
    for (const o of g.osm) {
      const into = wants(o).map((sex) => ofSex(sex)[0]!);
      if (!into.length) continue;
      decided.add(o.sourceKey);
      if (o.activity > 0) {
        plan.keptInUse.push({ osm: o, by: into[0]!, rule: 'floor' });
        why.set(o.sourceKey, 'in use (would merge by floor)');
      } else move(o, into, 'floor');
    }
  }

  // 3. Generic OSM toilets in the same room as a survey2 toilet
  for (const o of osm) {
    if (decided.has(o.sourceKey) || ambiguousOsm.has(o.sourceKey)) continue;
    const hit = findNearSurveyed(o, o.generic, s2);
    if (!hit) continue;
    decided.add(o.sourceKey);
    if (o.activity > 0) {
      plan.keptInUse.push({ osm: o, by: hit.toilet, rule: hit.rule });
      why.set(o.sourceKey, 'in use (would be retired)');
    } else plan.retired.push({ osm: o, by: hit.toilet, distanceM: Math.round(hit.distanceM), rule: hit.rule === 'merged' ? 'merged-position' : 'near-15m' });
  }

  // What stays within OSM_NEAR_REVIEW_M, and why
  const gone = new Set([...plan.merged.map((m) => m.osm.sourceKey), ...plan.retired.map((r) => r.osm.sourceKey)]);
  for (const o of osm) {
    if (gone.has(o.sourceKey)) continue;
    const n = nearest(o);
    if (!n || n.d >= OSM_NEAR_REVIEW_M) continue;
    const reason =
      why.get(o.sourceKey) ??
      (o.activity > 0
        ? 'in use'
        : !o.generic
          ? 'a place of its own'
          : n.d > NEAR_SURVEY_RADIUS_M
            ? `over ${NEAR_SURVEY_RADIUS_M} m`
            : 'not the same room (sex or level differs)');
    plan.near.push({ osm: o, by: n.t, distanceM: Math.round(n.d), reason });
  }
  plan.near.sort((a, b) => a.distanceM - b.distanceM || a.osm.sourceKey.localeCompare(b.osm.sourceKey));
  return plan;
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
  // prev: the venue's point before this run moved it (a geocode fix), so its toilets follow it.
  const venueOf = new Map<string, { id: string; lat: number; lng: number; prev: { lat: number; lng: number } }>();
  const createdFor = new Map<string, VenueRow>(); // unresolved existing key -> venue created this run
  for (const v of fw.venues) {
    const m = matches.venues[v.key]!;
    let target = m.existingVenueSourceKey ? resolveVenue(m.existingVenueSourceKey, allVenues) : null;
    if (m.existingVenueSourceKey && !target) target = createdFor.get(m.existingVenueSourceKey) ?? null;
    if (target && target.sourceKey !== `survey2-venue:${v.key}`) {
      await linkVenue(db, target, v, venueT);
      venueOf.set(v.key, { id: target.id, lat: target.latitude, lng: target.longitude, prev: { lat: target.latitude, lng: target.longitude } });
      continue;
    }
    if (m.existingVenueSourceKey) venueT.matchedButAbsent.push(`${v.key} -> ${m.existingVenueSourceKey}`);
    const g = geo[v.key];
    if (!g || !inSingapore(g.lat, g.lng)) throw new Error(`survey2 venue ${v.key} is not geocoded / outside Singapore. Run \`pnpm cli geocode\`.`);
    const before = allVenues.find((x) => x.sourceKey === v.sourceKey);
    const prev = before ? { lat: before.latitude, lng: before.longitude } : null;
    const row = await upsertOwnVenue(db, v, g, overrides[v.key], allVenues, venueT);
    if (m.existingVenueSourceKey) createdFor.set(m.existingVenueSourceKey, row);
    venueOf.set(v.key, { id: row.id, lat: row.latitude, lng: row.longitude, prev: prev ?? { lat: row.latitude, lng: row.longitude } });
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
        // A toilet away from its venue's point has a position of its own (merged onto an OSM toilet's, below, or
        // moved by hand): it keeps it while its venue stays the same. Otherwise it sits on (follows) the venue's point.
        const placed = ex.venueId === c.id && !atPoint(ex, c) && !atPoint(ex, c.prev);
        // Curated values only fill gaps (people may have corrected them since), as in seed:fieldwork.
        const data = {
          venueId: c.id,
          latitude: placed ? ex.latitude : c.lat,
          longitude: placed ? ex.longitude : c.lng,
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
  const osm = await settleOsmToilets(db);

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
    osmSuperseded: osm.osmSuperseded,
    osmMerged: osm.osmMerged,
    osmMergeAmbiguous: osm.osmMergeAmbiguous,
    osmKeptInUse: osm.osmKeptInUse,
    survey2OsmNear: `${osm.review} item(s) in review.json`,
    rows: fw.toilets.length,
    ownToilets: own.length,
    rowsOnPilotToilets: attached.length,
  };
  console.log(JSON.stringify(log, null, 2));
  return {
    inserted: venueT.inserted + toiletT.inserted + featT.inserted + surveyT.inserted,
    updated: venueT.updated + toiletT.updated + featT.updated + surveyT.updated + featT.deleted + surveyT.deleted + staleLog.deleted.length + osm.osmSuperseded.length + osm.osmMerged.length,
    skipped: featT.protected,
    log,
  };
}

const ACTIVITY = { reviews: true, statusReports: true, photos: true, checkIns: true, flags: true, submissions: true } as const;

/**
 * The OSM toilets the survey supersedes. First import:osm's dedupe the other way round (planOsmSupersede: same venue,
 * within 40 m), then the ones at other venues (planOsmNear: overrides.json `osmOverrides`, merge by floor, retire a
 * generic toilet in the same room). Deletes / moves in the DB and writes review.json `survey2OsmNear`.
 */
async function settleOsmToilets(db: PrismaClient) {
  const overrides = loadOsmOverrides();
  const ownRows = await db.toilet.findMany({
    where: { source: SOURCE, sourceKey: { startsWith: 'survey2:' }, status: 'ACTIVE' },
    select: {
      id: true,
      sourceKey: true,
      venueId: true,
      source: true,
      latitude: true,
      longitude: true,
      level: true,
      accessNote: true,
      openingHours: true,
      venue: { select: { sourceKey: true, name: true, latitude: true, longitude: true } },
    },
  });
  const venuePoint = new Map(ownRows.map((t) => [t.venueId, { lat: t.venue.latitude, lng: t.venue.longitude }]));
  const venueOf = new Map(ownRows.map((t) => [t.venueId, t.venue]));
  const surveyed: SurveyedToilet[] = ownRows.map((t) => ({
    id: t.id,
    sourceKey: t.sourceKey,
    venueId: t.venueId,
    source: t.source,
    lat: t.latitude,
    lng: t.longitude,
    level: t.level,
    sex: survey2SexOf(t.sourceKey),
    placed: !atPoint(t, venuePoint.get(t.venueId)!),
  }));

  // 1. Same venue (an override takes the toilet out of this rule)
  const sameVenue = await db.toilet.findMany({
    where: { source: 'OSM', status: 'ACTIVE', venueId: { in: [...venuePoint.keys()] }, sourceKey: { notIn: Object.keys(overrides) } },
    include: {
      venue: { select: { sourceKey: true } },
      features: { where: { source: { in: PROTECTED_SOURCES } }, select: { feature: true } },
      _count: { select: ACTIVITY },
    },
  });
  const plan = planOsmSupersede(
    sameVenue.map((t) => ({
      id: t.id,
      sourceKey: t.sourceKey,
      venueId: t.venueId,
      source: t.source,
      lat: t.latitude,
      lng: t.longitude,
      activity: t.features.length + Object.values(t._count).reduce((a, n) => a + n, 0),
    })),
    surveyed,
  );
  const venueKeyOf = new Map(sameVenue.map((t) => [t.id, t.venue.sourceKey]));
  const osmSuperseded: Record<string, unknown>[] = plan.remove.map((r) => ({
    osm: r.osm.sourceKey,
    survey2: r.by.sourceKey,
    venue: venueKeyOf.get(r.osm.id)!,
    distanceM: r.distanceM,
    rule: 'same-venue-40m',
  }));
  const osmKeptInUse: Record<string, unknown>[] = plan.keep.map((r) => ({
    osm: r.osm.sourceKey,
    survey2: r.by.sourceKey,
    venue: venueKeyOf.get(r.osm.id)!,
    rule: 'same-venue-40m',
  }));
  if (plan.remove.length) await db.toilet.deleteMany({ where: { id: { in: plan.remove.map((r) => r.osm.id) } } });

  // 2. Every other ACTIVE OSM toilet near a survey2 toilet or venue point (or named in osmOverrides)
  const removed = new Set(plan.remove.map((r) => r.osm.id));
  const points = new PointIndex<{ lat: number; lng: number }>();
  for (const t of surveyed) points.add(t);
  for (const p of venuePoint.values()) points.add(p);
  const radius = Math.max(OSM_MERGE_RADIUS_M, OSM_NEAR_REVIEW_M);
  const ids = (
    await db.toilet.findMany({ where: { source: 'OSM', status: 'ACTIVE' }, select: { id: true, sourceKey: true, latitude: true, longitude: true } })
  )
    .filter((t) => !removed.has(t.id) && (overrides[t.sourceKey] || points.near(t.latitude, t.longitude, radius).length > 0))
    .map((t) => t.id);
  const rows = await db.toilet.findMany({
    where: { id: { in: ids } },
    include: {
      venue: { select: { sourceKey: true, name: true, type: true, source: true, externalIds: true } },
      features: {
        where: { OR: [{ source: { in: PROTECTED_SOURCES } }, { source: 'OSM', feature: { in: ALL_SEXES } }] },
        select: { feature: true, present: true, source: true },
      },
      _count: { select: ACTIVITY },
    },
  });
  const rowOf = new Map(rows.map((t) => [t.sourceKey, t]));
  const near = planOsmNear(
    rows.map((t) => ({
      id: t.id,
      sourceKey: t.sourceKey,
      venueId: t.venueId,
      source: t.source,
      lat: t.latitude,
      lng: t.longitude,
      activity: t.features.filter((f) => f.source !== 'OSM').length + Object.values(t._count).reduce((a, n) => a + n, 0),
      level: t.level,
      sexes: ALL_SEXES.filter((s) => t.features.some((f) => f.source === 'OSM' && f.feature === s && f.present)),
      generic: isGenericToiletVenue(t.venue),
    })),
    surveyed,
    venuePoint,
    overrides,
  );

  const s2Of = new Map(ownRows.map((t) => [t.sourceKey, t]));
  const osmMerged: Record<string, unknown>[] = [];
  for (const m of near.merged) {
    const o = rowOf.get(m.osm.sourceKey)!;
    await db.$transaction(async (tx) => {
      for (const into of m.into) {
        const s = s2Of.get(into.sourceKey)!;
        // The survey's own note and hours win; OSM's only fill a gap.
        await tx.toilet.update({
          where: { id: s.id },
          data: {
            latitude: o.latitude,
            longitude: o.longitude,
            accessNote: s.accessNote ?? o.accessNote,
            ...(s.openingHours === null && o.openingHours !== null ? { openingHours: toJson(o.openingHours) } : {}),
          },
        });
        osmMerged.push({
          osm: o.sourceKey,
          survey2: s.sourceKey,
          venue: s.venue.sourceKey,
          venueName: s.venue.name,
          level: s.level,
          distanceM: m.distanceM,
          rule: m.rule,
        });
      }
      await tx.toilet.delete({ where: { id: o.id } });
    });
  }
  if (near.retired.length) await db.toilet.deleteMany({ where: { id: { in: near.retired.map((r) => r.osm.id) } } });
  for (const r of near.retired) {
    const o = rowOf.get(r.osm.sourceKey)!;
    osmSuperseded.push({
      osm: o.sourceKey,
      osmVenue: o.venue.name,
      survey2: r.by?.sourceKey ?? null,
      venue: r.by ? venueOf.get(r.by.venueId)?.sourceKey : null,
      venueName: r.by ? venueOf.get(r.by.venueId)?.name : null,
      distanceM: r.distanceM,
      rule: r.rule,
    });
  }
  for (const k of near.keptInUse)
    osmKeptInUse.push({ osm: k.osm.sourceKey, survey2: k.by?.sourceKey ?? null, venue: rowOf.get(k.osm.sourceKey)!.venue.sourceKey, rule: k.rule });
  const osmMergeAmbiguous = near.ambiguous.map(({ venueId, ...a }) => ({ venue: venueOf.get(venueId)?.sourceKey, venueName: venueOf.get(venueId)?.name, ...a }));

  const review: ReviewItem[] = [
    ...near.ambiguous.map((a) => ({
      kind: 'survey2-osm-merge-ambiguous',
      key: a.osm.join(' '),
      message: `${venueOf.get(a.venueId)?.name} ${a.level}: ${a.reason}`,
      resolution: 'kept as is; overrides.json osmOverrides { "<osm key>": { "mergeInto": "<survey2 key>" } } merges one by hand',
      data: { venue: venueOf.get(a.venueId)?.sourceKey, level: a.level, osm: a.osm, survey2: a.survey2 },
    })),
    ...near.near.map((n) => {
      const o = rowOf.get(n.osm.sourceKey)!;
      const where = `${venueOf.get(n.by.venueId)?.name}${n.by.level ? ` (${n.by.level})` : ''}`;
      return {
        kind: 'survey2-osm-near',
        key: o.sourceKey,
        message: `OSM toilet at "${o.venue.name}"${o.level ? ` (${o.level})` : ''} is ${n.distanceM} m from ${n.by.sourceKey} at ${where}`,
        resolution: `kept: ${n.reason}`,
        data: { osmVenue: o.venue.sourceKey, survey2: n.by.sourceKey, distanceM: n.distanceM },
      };
    }),
    ...near.unusedOverrides.map((u) => ({ kind: 'survey2-osm-override-unused', key: u.key, message: u.reason, resolution: 'auto: ignored' })),
  ];
  writeJson(paths.review, { ...loadReview(), survey2OsmNear: review });
  return { osmSuperseded, osmMerged, osmMergeAmbiguous, osmKeptInUse, review: review.length };
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
