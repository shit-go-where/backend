import type { FeatureName, OpeningHours } from '../curated/schema.js';
import { haversineM } from '../lib/geo.js';
import { nameKey } from '../lib/slug.js';
import { isFieldwork } from '../../common/sources.js';

export type Tags = Record<string, string>;
export type VenueTypeName =
  | 'MRT_STATION'
  | 'BUS_INTERCHANGE'
  | 'MALL'
  | 'HAWKER_CENTRE'
  | 'COFFEESHOP'
  | 'COMMUNITY_CLUB'
  | 'PARK'
  | 'LIBRARY'
  | 'HOSPITAL'
  | 'SPORTS_CENTRE'
  | 'OTHER';

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Tags;
}

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)';

const yes = (v: string | undefined) => v !== undefined && /^(yes|designated|true|1)$/i.test(v.trim());
const no = (v: string | undefined) => v !== undefined && /^(no|false|0)$/i.test(v.trim());

/** Is this element a toilet *feature of something else* (toilets=yes on a shop/mall/restaurant)? */
export function isToiletsOnFeature(tags: Tags): boolean {
  return tags['amenity'] !== 'toilets' && yes(tags['toilets']);
}

/** Access: returns null to skip the element entirely (private / no). */
export function accessOf(tags: Tags): { skip: boolean; note: string | null } {
  const raw = (isToiletsOnFeature(tags) ? tags['toilets:access'] ?? tags['access'] : tags['access'] ?? tags['toilets:access'])?.toLowerCase();
  if (raw === 'private' || raw === 'no') return { skip: true, note: null };
  const notes: Record<string, string> = {
    customers: 'Customers only',
    passengers: 'Passengers only',
    permit: 'Permit required',
    employees: 'Staff only',
    students: 'Students only',
  };
  return { skip: false, note: raw ? notes[raw] ?? null : null };
}

/** OSM tags -> feature booleans. Only sets what the tags actually say. */
export function featuresFromTags(tags: Tags): Partial<Record<FeatureName, boolean>> {
  const f: Partial<Record<FeatureName, boolean>> = {};
  const set = (k: FeatureName, v: boolean | undefined) => {
    if (v !== undefined) f[k] = v;
  };
  const tri = (v: string | undefined) => (yes(v) ? true : no(v) ? false : undefined);

  const wheelchair = tags['toilets:wheelchair'] ?? tags['wheelchair'];
  set('ACCESSIBLE', tri(wheelchair));
  set('FREE', tags['fee'] === 'no' ? true : tags['fee'] === 'yes' ? false : undefined);
  set('BABY_CHANGE', tri(tags['changing_table'] ?? tags['diaper']));
  const pos = (tags['toilets:position'] ?? '').toLowerCase().split(/[;,]/).map((s) => s.trim());
  if (pos.includes('seated')) f.SITTING = true;
  if (pos.includes('squat')) f.SQUAT = true;
  set('MALE', tri(tags['male']));
  set('FEMALE', tri(tags['female']));
  set('UNISEX', tri(tags['unisex']));
  // Hand soap only when soap is explicitly tagged (toilets:handwashing=yes says nothing about soap).
  set('HAND_SOAP', tri(tags['toilets:handwashing:soap'] ?? tags['soap']));
  const shower = tags['shower'];
  set('SHOWER', shower === undefined ? undefined : no(shower) ? false : true);
  set('TOILET_PAPER', tri(tags['toilets:paper_supplied']));
  const drying = (tags['toilets:hands_drying'] ?? '').toLowerCase();
  if (/electric_hand_dryer|hand_dryer/.test(drying)) f.HAND_DRYER = true;
  if (/paper_towel/.test(drying)) f.HAND_TOWEL = true;
  if (yes(tags['toilets:bidet'] ?? tags['bidet'])) f.BIDET = true;
  // "limited" (e.g. a vending machine) still means you can get some.
  const menstrual = tags['toilets:menstrual_products'];
  set('PERIOD_PRODUCTS', menstrual?.trim().toLowerCase() === 'limited' ? true : tri(menstrual));
  set('WATER_REFILL', tri(tags['drinking_water']));
  return f;
}

export function openingHoursOf(tags: Tags): OpeningHours | null {
  const v = tags['opening_hours']?.trim();
  if (!v) return null;
  if (v === '24/7') return { type: 'always' };
  return { type: 'osm', value: v };
}

/**
 * Prefer a human level reference ("L1", "B2") over the OSM numeric level. OSM counts the ground
 * floor as 0, Singapore as L1, so a bare `level=1` is L2 here and `level=-1` is B1. A toilet on
 * several floors is `level=0;1`: each part is converted ("L1; L2"); parts that aren't whole
 * numbers ("0.5", "roof") are kept as they are for normalizeLevel.
 */
export function levelOf(tags: Tags): string | null {
  const ref = tags['level:ref'] ?? tags['addr:floor'];
  if (ref) return ref;
  const lv = tags['level']?.trim();
  if (!lv) return null;
  const parts = lv
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.some((p) => /^-?\d+$/.test(p))) return lv;
  return parts
    .map((p) => {
      if (!/^-?\d+$/.test(p)) return p;
      const n = Number(p);
      return n >= 0 ? `L${n + 1}` : `B${-n}`;
    })
    .join('; ');
}

export function venueTypeFromTags(tags: Tags): VenueTypeName {
  const a = tags['amenity'];
  if (tags['shop'] === 'mall' || tags['shop'] === 'department_store') return 'MALL';
  if (a === 'marketplace' || /hawker/i.test(tags['name'] ?? '')) return 'HAWKER_CENTRE';
  if (a === 'library') return 'LIBRARY';
  if (a === 'community_centre') return 'COMMUNITY_CLUB';
  if (a === 'hospital' || a === 'clinic') return 'HOSPITAL';
  if (a === 'bus_station') return 'BUS_INTERCHANGE';
  if (tags['leisure'] === 'park' || tags['leisure'] === 'nature_reserve') return 'PARK';
  if (tags['leisure'] === 'sports_centre') return 'SPORTS_CENTRE';
  if ((tags['railway'] === 'station' && tags['station'] === 'subway') || tags['station'] === 'subway') return 'MRT_STATION';
  return 'OTHER';
}

export function venueNameFromTags(tags: Tags): string {
  return tags['name:en'] ?? tags['name'] ?? tags['operator'] ?? 'Public toilet';
}

export function elementLatLng(e: OsmElement): { lat: number; lng: number } | null {
  const lat = e.lat ?? e.center?.lat;
  const lng = e.lon ?? e.center?.lon;
  return lat === undefined || lng === undefined ? null : { lat, lng };
}

export interface VenueCandidate {
  id: string;
  name: string;
  lat: number;
  lng: number;
  toiletStatus: string;
}

/** Same-name test that tolerates "Suntec City" vs "Suntec City Mall". */
export function similarName(a: string, b: string): boolean {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * Venue to attach an OSM toilet to: an existing venue within `radiusM` that does not say
 * "no toilets here" (NONE / USES_NEARBY), preferring one with a similar name, else the nearest.
 */
export function chooseVenue(
  point: { lat: number; lng: number },
  name: string | undefined,
  candidates: { item: VenueCandidate; distanceM: number }[],
  radiusM = 60,
  requireName = false,
): VenueCandidate | null {
  const ok = candidates.filter(
    (c) => c.distanceM <= radiusM && c.item.toiletStatus !== 'NONE' && c.item.toiletStatus !== 'USES_NEARBY',
  );
  if (name) {
    const named = ok.find((c) => similarName(c.item.name, name));
    if (named) return named.item;
  }
  if (requireName) return null;
  return ok[0]?.item ?? null;
}

export interface ExistingToilet {
  id: string;
  sourceKey: string;
  venueId: string;
  source: string;
  lat: number;
  lng: number;
}

/**
 * Dedupe rule: skip an OSM toilet when a fieldwork (either 2024 survey) or COMMUNITY toilet at the same venue is
 * within `radiusM` metres (the human-verified record wins). Returns the matching toilet.
 */
export function findDuplicate(
  point: { lat: number; lng: number },
  venueId: string,
  toilets: ExistingToilet[],
  radiusM = 40,
): ExistingToilet | null {
  let best: ExistingToilet | null = null;
  let bestD = Infinity;
  for (const t of toilets) {
    if (t.venueId !== venueId || (!isFieldwork(t.source) && t.source !== 'COMMUNITY')) continue;
    const d = haversineM(point.lat, point.lng, t.lat, t.lng);
    if (d <= radiusM && d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

export type ToiletSex = 'MALE' | 'FEMALE' | 'UNISEX';
const SEXES: ToiletSex[] = ['MALE', 'FEMALE', 'UNISEX'];

/** The sexes an OSM toilet is tagged for (male / female / unisex = yes); empty when it says nothing. */
export function osmSexes(features: Partial<Record<FeatureName, boolean>>): ToiletSex[] {
  return SEXES.filter((s) => features[s] === true);
}

/** `survey2:M11/female/b1` -> FEMALE. Every survey2 toilet key carries its sex. */
export function survey2SexOf(sourceKey: string): ToiletSex | null {
  const m = /^survey2:[^/]+\/(male|female|unisex)(?:\/|$)/.exec(sourceKey);
  return m ? (m[1]!.toUpperCase() as ToiletSex) : null;
}

/** Names that make an OSM venue a place of its own even when it is typed OTHER. */
const PLACE_NAME = /\b(?:library|community (?:club|centre|center)|station|interchange|mrt|lrt)\b/i;

/**
 * Is this the venue of a generic OSM toilet rather than a real place? An OSM venue (`osmKind` toilet =
 * an amenity=toilets block, feature = toilets=yes on something) of type OTHER or MALL that data.gov.sg
 * has not claimed and that is not named like a library / community club / station: "Public toilet", or
 * a toilet node that inherited a shop's name ("Don Don Donki", "Gourmet Express").
 */
export function isGenericToiletVenue(v: { source: string; type: string; name: string; externalIds: unknown }): boolean {
  if (v.source !== 'OSM') return false;
  const ext = (v.externalIds as Record<string, unknown> | null) ?? {};
  if (ext['osmKind'] !== 'toilet' && ext['osmKind'] !== 'feature') return false;
  if (ext['datagov']) return false;
  if (v.type !== 'OTHER' && v.type !== 'MALL') return false;
  return !PLACE_NAME.test(v.name);
}

/** A survey2 toilet within this distance of a generic OSM toilet, at any venue, is the same room. */
export const NEAR_SURVEY_RADIUS_M = 15;
/** A survey2 toilet this close to an OSM toilet sits on its coordinates: it was merged onto it. */
export const MERGED_AT_M = 1;

export interface SurveyedToilet extends ExistingToilet {
  /** Normalised level, or null. */
  level: string | null;
  sex: ToiletSex | null;
  /** Not at its venue's point any more: merged onto an OSM toilet's position (or moved by hand). */
  placed: boolean;
}

/**
 * The second dedupe rule, across venues: an OSM toilet is the survey2 toilet that sits on its own
 * coordinates (merged), or, when the OSM toilet is generic (isGenericToiletVenue), the nearest survey2
 * toilet within 15 m that could be the same room: a sex the OSM toilet is tagged for (any when untagged)
 * and, when the survey2 toilet has a real position (`placed`) and both levels are known, the same level.
 */
export function findNearSurveyed(
  point: { lat: number; lng: number; level: string | null; sexes: ToiletSex[] },
  generic: boolean,
  toilets: SurveyedToilet[],
  radiusM = NEAR_SURVEY_RADIUS_M,
): { toilet: SurveyedToilet; distanceM: number; rule: 'merged' | 'near-15m' } | null {
  let best: { toilet: SurveyedToilet; distanceM: number; rule: 'merged' | 'near-15m' } | null = null;
  for (const t of toilets) {
    if (t.source !== 'FIELDWORK_2024_EXPANDED') continue;
    const d = haversineM(point.lat, point.lng, t.lat, t.lng);
    if (best && d >= best.distanceM) continue;
    if (d <= MERGED_AT_M) best = { toilet: t, distanceM: d, rule: 'merged' };
    else if (generic && d <= radiusM && sameRoomCandidate(point, t)) best = { toilet: t, distanceM: d, rule: 'near-15m' };
  }
  return best;
}

function sameRoomCandidate(o: { level: string | null; sexes: ToiletSex[] }, t: SurveyedToilet): boolean {
  if (o.sexes.length && (!t.sex || !o.sexes.includes(t.sex))) return false;
  if (t.placed && o.level && t.level && o.level !== t.level) return false;
  return true;
}

/**
 * Whether the import may reopen a CLOSED OSM toilet that is back in the snapshot. Only one it closed
 * itself: nobody has touched it (no reviews, check-ins, status reports, photos, flags, submissions or
 * COMMUNITY/ADMIN features). A toilet an admin closed, or that people reported, stays closed.
 */
export function canReopen(t: {
  status: string;
  features: { source: string }[];
  _count: Record<string, number>;
}): boolean {
  if (t.status !== 'CLOSED') return false;
  if (t.features.some((f) => f.source !== 'OSM')) return false;
  return Object.values(t._count).every((n) => n === 0);
}
