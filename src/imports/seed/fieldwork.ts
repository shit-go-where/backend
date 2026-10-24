import { Prisma, type DataSource, type PrismaClient } from '../../generated/prisma/client.js';
import {
  loadFieldwork,
  loadGeocoded,
  loadOverrides,
  type CuratedSurvey,
  type CuratedToilet,
  type FeatureName,
} from '../curated/schema.js';
import { loadEnrichment, type Enrichment } from '../enrich.js';
import { inSingapore } from '../lib/geo.js';
import { toJson, type RunCounts } from '../lib/importRun.js';
import { levelFields } from '../../common/level.js';

const SOURCE: DataSource = 'FIELDWORK_2024';
/** Feature sources that an import must never overwrite. */
export const PROTECTED_SOURCES: DataSource[] = ['COMMUNITY', 'ADMIN'];
/** The expanded survey (Aug-Oct 2024) saw these toilets after the pilot (March): the newer observation wins. */
export const PILOT_PROTECTED: DataSource[] = [...PROTECTED_SOURCES, 'FIELDWORK_2024_EXPANDED'];

type Tx = Prisma.TransactionClient;

/** JSON.stringify with sorted keys (jsonb does not preserve key order). */
export function stableStringify(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
/** "2024-03-15" (Singapore midnight) or a full "2024-08-24T09:15:35+08:00" timestamp. */
export const sgDate = (iso: string) => new Date(iso.includes('T') ? iso : `${iso}T00:00:00+08:00`);
const date = sgDate;

export interface Tally {
  inserted: number;
  updated: number;
  unchanged: number;
}
export const tally = (): Tally => ({ inserted: 0, updated: 0, unchanged: 0 });

export interface FeatureWant {
  feature: FeatureName;
  present: boolean;
  source: DataSource;
  observedAt: Date;
}
interface FeatureRow {
  feature: string;
  present: boolean;
  source: DataSource;
  observedAt: Date;
}

/**
 * Decide what to do with one feature. Fieldwork never overwrites COMMUNITY/ADMIN rows; ADMIN
 * (enrichment) overwrites anything but keeps its observedAt when the value did not change.
 * `newerWins` lists other sources whose row is kept when it was observed later than `want`
 * (the two 2024 surveys: whichever looked at the toilet last wins).
 */
export function planFeature(
  existing: FeatureRow | undefined,
  want: FeatureWant,
  protectedSources: DataSource[] = PROTECTED_SOURCES,
  newerWins: DataSource[] = [],
): 'create' | 'update' | 'keep' | 'protected' {
  if (!existing) return 'create';
  if (want.source !== 'ADMIN' && existing.source !== want.source && protectedSources.includes(existing.source)) return 'protected';
  if (existing.source !== want.source && newerWins.includes(existing.source) && existing.observedAt.getTime() > want.observedAt.getTime())
    return 'protected';
  if (want.source === 'ADMIN' && existing.source === 'ADMIN' && existing.present === want.present) return 'keep';
  if (existing.present === want.present && existing.source === want.source && existing.observedAt.getTime() === want.observedAt.getTime())
    return 'keep';
  return 'update';
}

/** Apply wanted features to a toilet; deletes stale rows from `ownSource` only. */
export async function syncFeatures(
  tx: Tx,
  toiletId: string,
  existing: FeatureRow[],
  wants: FeatureWant[],
  ownSource: DataSource,
  t: Tally & { protected: number; deleted: number },
  protectedSources: DataSource[] = PROTECTED_SOURCES,
  newerWins: DataSource[] = [],
): Promise<void> {
  const byFeature = new Map(existing.map((f) => [f.feature, f]));
  for (const w of wants) {
    const plan = planFeature(byFeature.get(w.feature), w, protectedSources, newerWins);
    if (plan === 'protected') t.protected++;
    else if (plan === 'keep') t.unchanged++;
    else {
      const data = { present: w.present, source: w.source, observedAt: plan === 'update' && w.source === 'ADMIN' ? new Date() : w.observedAt };
      await tx.toiletFeature.upsert({
        where: { toiletId_feature: { toiletId, feature: w.feature } },
        create: { toiletId, feature: w.feature, ...data },
        update: data,
      });
      if (plan === 'create') t.inserted++;
      else t.updated++;
    }
  }
  const wanted = new Set(wants.map((w) => w.feature));
  for (const f of existing)
    if (f.source === ownSource && !wanted.has(f.feature as FeatureName)) {
      await tx.toiletFeature.delete({ where: { toiletId_feature: { toiletId, feature: f.feature as FeatureName } } });
      t.deleted++;
    }
}

export function surveyData(s: CuratedSurvey, source: DataSource = SOURCE) {
  return {
    surveyedAt: date(s.surveyedAt),
    rubric: s.rubric,
    sex: s.sex,
    phase: s.phase,
    cleanliness: s.cleanliness,
    scent: s.scent,
    aesthetics: s.aesthetics,
    music: s.music,
    toiletries: s.toiletries,
    facilities: s.facilities,
    total: s.total,
    rasStars: s.rasStars,
    remarks: s.remarks,
    // Compared as-is with the stored row (null = no breakdown); writeSurvey turns null into DbNull.
    breakdown: s.breakdown === null ? null : toJson(s.breakdown),
    raw: toJson({ ...s.raw, _key: s.key, _source: source }),
  };
}

/** A nullable Json column is cleared with DbNull, not null. */
function writeSurvey(data: ReturnType<typeof surveyData>) {
  return { ...data, breakdown: data.breakdown ?? Prisma.DbNull };
}

export async function seedFieldwork(db: PrismaClient): Promise<RunCounts & { log: Record<string, unknown> }> {
  const fw = loadFieldwork();
  const geo = loadGeocoded();
  const overrides = loadOverrides();
  const enrichment = loadEnrichment();
  const enrichBy = new Map(enrichment.map((e) => [e.sourceKey, e]));
  const observedAt = date(fw.source.observedAt);

  const missing = fw.venues.filter((v) => !geo[v.key] || !inSingapore(geo[v.key]!.lat, geo[v.key]!.lng));
  if (missing.length)
    throw new Error(`Not geocoded / outside Singapore: ${missing.map((v) => v.key).join(', ')}. Run \`pnpm cli geocode\`.`);

  const venueT = tally();
  const toiletT = tally();
  const featT = { ...tally(), protected: 0, deleted: 0 };
  const surveyT = { ...tally(), deleted: 0 };

  // ── Venues
  const existingVenues = new Map(
    (await db.venue.findMany({ where: { sourceKey: { in: fw.venues.map((v) => v.sourceKey) } } })).map((v) => [v.sourceKey, v]),
  );
  const venueIdByKey = new Map<string, string>();
  const venueCoords = new Map<string, { lat: number; lng: number }>();
  for (const v of fw.venues) {
    const g = geo[v.key]!;
    const ex = existingVenues.get(v.sourceKey);
    const usesNearby = v.usesNearbyVenueKey ? fw.venues.find((o) => o.key === v.usesNearbyVenueKey)?.sourceKey : undefined;
    const externalIds = {
      ...((ex?.externalIds as Record<string, unknown> | null) ?? {}),
      sheetVenueKey: v.key,
      ...(usesNearby ? { usesNearbyVenueSourceKey: usesNearby } : {}),
    };
    const lines = [...v.lines, ...(ex?.lines ?? []).filter((l) => !v.lines.includes(l))];
    const data = {
      name: g.name ?? v.name,
      type: v.type,
      latitude: g.lat,
      longitude: g.lng,
      // Other importers (data.gov.sg) may have filled a better address; overrides.json always wins.
      address: overrides[v.key]?.address ?? ex?.address ?? g.address,
      postalCode: overrides[v.key]?.postalCode ?? ex?.postalCode ?? g.postalCode,
      planningArea: g.planningArea,
      lines,
      toiletStatus: v.toiletStatus,
      note: v.note,
      openingHours: v.openingHours ? toJson(v.openingHours) : undefined,
      source: SOURCE,
      externalIds: toJson(externalIds),
    };
    venueCoords.set(v.key, { lat: g.lat, lng: g.lng });
    if (!ex) {
      const created = await db.venue.create({ data: { ...data, sourceKey: v.sourceKey } });
      venueIdByKey.set(v.key, created.id);
      venueT.inserted++;
      continue;
    }
    venueIdByKey.set(v.key, ex.id);
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
      externalIds: ex.externalIds,
    };
    if (same(cur, data)) venueT.unchanged++;
    else {
      await db.venue.update({ where: { id: ex.id }, data });
      venueT.updated++;
    }
  }

  // ── Toilets, features, surveys
  const existingToilets = new Map(
    (
      await db.toilet.findMany({
        where: { sourceKey: { in: fw.toilets.map((t) => t.sourceKey) } },
        include: { features: true, surveys: true },
      })
    ).map((t) => [t.sourceKey, t]),
  );
  for (const t of fw.toilets) {
    const e = enrichBy.get(t.sourceKey);
    const ex = existingToilets.get(t.sourceKey);
    const venueId = venueIdByKey.get(t.venueKey)!;
    const c = venueCoords.get(t.venueKey)!;
    await db.$transaction(async (tx) => {
      let toiletId: string;
      if (!ex) {
        const created = await tx.toilet.create({
          data: {
            venueId,
            label: t.label,
            latitude: c.lat,
            longitude: c.lng,
            ...levelFields(e?.level ?? t.level),
            areaType: e?.areaType ?? t.areaType,
            nearestExit: e?.nearestExit ?? null,
            accessNote: e?.notes ?? null,
            tier: t.tier,
            status: t.status,
            source: SOURCE,
            sourceKey: t.sourceKey,
            lastVerifiedAt: date(t.lastVerifiedAt),
            needsResurvey: t.needsResurvey,
          },
        });
        toiletId = created.id;
        toiletT.inserted++;
      } else {
        toiletId = ex.id;
        const lv = date(t.lastVerifiedAt);
        // Curated values only fill gaps (people may have corrected them since); enrichment (ADMIN) wins.
        const data = {
          venueId,
          latitude: c.lat,
          longitude: c.lng,
          tier: ex.tier === 'VERIFIED' ? ex.tier : t.tier,
          label: ex.label ?? t.label,
          ...levelFields(e?.level ?? ex.level ?? t.level),
          areaType: e?.areaType ?? (ex.areaType === 'UNKNOWN' ? t.areaType : ex.areaType),
          nearestExit: e?.nearestExit ?? ex.nearestExit,
          accessNote: e?.notes ?? ex.accessNote,
          needsResurvey: ex.needsResurvey || t.needsResurvey,
          lastVerifiedAt: ex.lastVerifiedAt && ex.lastVerifiedAt > lv ? ex.lastVerifiedAt : lv,
        };
        const cur = {
          venueId: ex.venueId,
          latitude: ex.latitude,
          longitude: ex.longitude,
          tier: ex.tier,
          label: ex.label,
          level: ex.level,
          levelOrder: ex.levelOrder,
          areaType: ex.areaType,
          nearestExit: ex.nearestExit,
          accessNote: ex.accessNote,
          needsResurvey: ex.needsResurvey,
          lastVerifiedAt: ex.lastVerifiedAt,
        };
        if (same(cur, data)) toiletT.unchanged++;
        else {
          await tx.toilet.update({ where: { id: ex.id }, data });
          toiletT.updated++;
        }
      }
      await syncFeatures(tx, toiletId, ex?.features ?? [], featureWants(t, e, observedAt), SOURCE, featT, PILOT_PROTECTED);
      await syncSurveys(tx, toiletId, ex?.surveys ?? [], t.surveys, surveyT);
    });
  }

  // ── Enrichment rows for toilets that are not part of the sheet (e.g. osm:node/123)
  const enrichOther = { applied: 0, notFound: [] as string[] };
  const sheetKeys = new Set(fw.toilets.map((t) => t.sourceKey));
  for (const e of enrichment.filter((x) => !sheetKeys.has(x.sourceKey))) {
    const ex = await db.toilet.findUnique({ where: { sourceKey: e.sourceKey }, include: { features: true } });
    if (!ex) {
      enrichOther.notFound.push(e.sourceKey);
      continue;
    }
    await db.$transaction(async (tx) => {
      const data = {
        ...levelFields(e.level ?? ex.level),
        areaType: e.areaType ?? ex.areaType,
        nearestExit: e.nearestExit ?? ex.nearestExit,
        accessNote: e.notes ?? ex.accessNote,
      };
      if (!same(data, { level: ex.level, levelOrder: ex.levelOrder, areaType: ex.areaType, nearestExit: ex.nearestExit, accessNote: ex.accessNote }))
        await tx.toilet.update({ where: { id: ex.id }, data });
      await syncFeatures(tx, ex.id, ex.features, e.features.map((f) => ({ ...f, source: 'ADMIN' as const, observedAt: new Date() })), 'ADMIN', featT);
    });
    enrichOther.applied++;
  }

  const log = {
    venues: venueT,
    toilets: toiletT,
    features: featT,
    surveys: surveyT,
    enrichment: { rows: enrichment.length, nonSheetApplied: enrichOther.applied, notFound: enrichOther.notFound },
  };
  console.log(JSON.stringify(log, null, 2));
  return {
    inserted: venueT.inserted + toiletT.inserted + featT.inserted + surveyT.inserted,
    updated: venueT.updated + toiletT.updated + featT.updated + surveyT.updated + featT.deleted + surveyT.deleted,
    skipped: featT.protected + enrichOther.notFound.length,
    log,
  };
}

export function featureWants(t: CuratedToilet, e: Enrichment | undefined, observedAt: Date): FeatureWant[] {
  const out = new Map<FeatureName, FeatureWant>();
  for (const f of t.features) out.set(f.feature, { ...f, source: SOURCE, observedAt });
  // Enrichment (ADMIN): observedAt is replaced by "now" only when the value actually changes.
  for (const f of e?.features ?? []) out.set(f.feature, { ...f, source: 'ADMIN', observedAt });
  return [...out.values()];
}

/** Make the toilet's `source` surveys (raw._source) exactly `wanted`, matched by raw._key. */
export async function syncSurveys(
  tx: Tx,
  toiletId: string,
  existing: { id: string; raw: unknown; surveyedById: string | null; [k: string]: unknown }[],
  wanted: CuratedSurvey[],
  t: Tally & { deleted: number },
  source: DataSource = SOURCE,
): Promise<void> {
  const mine = existing.filter((s) => !s.surveyedById && (s.raw as Record<string, unknown> | null)?.['_source'] === source);
  const byKey = new Map(mine.map((s) => [(s.raw as Record<string, unknown>)['_key'] as string, s]));
  for (const s of wanted) {
    const data = surveyData(s, source);
    const ex = byKey.get(s.key);
    if (!ex) {
      await tx.survey.create({ data: { ...writeSurvey(data), toiletId } });
      t.inserted++;
      continue;
    }
    byKey.delete(s.key);
    const cur = Object.fromEntries(Object.keys(data).map((k) => [k, ex[k]]));
    if (same(cur, data)) t.unchanged++;
    else {
      await tx.survey.update({ where: { id: ex.id }, data: writeSurvey(data) });
      t.updated++;
    }
  }
  for (const stale of byKey.values()) {
    await tx.survey.delete({ where: { id: stale.id } });
    t.deleted++;
  }
}
