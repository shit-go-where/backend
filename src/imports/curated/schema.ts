import { z } from 'zod';
import { readJson, readJsonIfExists } from '../lib/files.js';
import { paths } from '../lib/paths.js';
import { ExpandedBreakdownSchema } from '../../toilets/survey-items.js';

export const VENUE_TYPES = [
  'MRT_STATION',
  'BUS_INTERCHANGE',
  'MALL',
  'HAWKER_CENTRE',
  'COFFEESHOP',
  'COMMUNITY_CLUB',
  'PARK',
  'LIBRARY',
  'HOSPITAL',
  'SPORTS_CENTRE',
  'OTHER',
] as const;
export const FEATURES = [
  'TOILET_PAPER',
  'HAND_TOWEL',
  'HAND_DRYER',
  'HAND_SOAP',
  'SEAT_LINER',
  'BIDET',
  'AUTO_FLUSH',
  'AUTO_TAP',
  'AUTO_SOAP',
  'COAT_HOOK',
  'FEEDBACK_DEVICE',
  'SIGNAGE',
  'POSTERS',
  'AMBULANT',
  'ACCESSIBLE',
  'CHILD',
  'BABY_CHANGE',
  'NURSING_ROOM',
  'SHOWER',
  'SITTING',
  'SQUAT',
  'MALE',
  'FEMALE',
  'UNISEX',
  'FREE',
  'SANITARY_BIN',
  'PERIOD_PRODUCTS',
  'MIRROR',
  'WATER_REFILL',
  'ABLUTION',
] as const;
export type FeatureName = (typeof FEATURES)[number];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const OpeningHoursSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('always') }),
  z.object({
    type: z.literal('weekly'),
    periods: z.array(z.object({ days: z.array(z.number().int().min(0).max(6)), open: hhmm, close: hhmm })),
    inferred: z.boolean().optional(),
  }),
  z.object({ type: z.literal('osm'), value: z.string() }),
]);
export type OpeningHours = z.infer<typeof OpeningHoursSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A day ("2024-03-15", read as Singapore midnight) or a Singapore timestamp ("2024-08-24T09:15:35+08:00"). */
const isoDateOrTime = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?\+08:00)?$/);

export const SURVEY_RUBRICS = ['PILOT_50', 'EXPANDED_2024'] as const;
export const SURVEY_SEXES = ['MALE', 'FEMALE', 'UNISEX'] as const;

/**
 * One Survey row. PILOT_50 fills the pilot columns (integers) and has no breakdown; EXPANDED_2024 leaves
 * them null and carries its native values in `breakdown` (shape: src/toilets/survey-items.ts).
 */
export const CuratedSurveySchema = z
  .object({
    /** Deterministic key, stored in Survey.raw._key so re-seeding matches the same row. */
    key: z.string(),
    surveyedAt: isoDateOrTime,
    rubric: z.enum(SURVEY_RUBRICS),
    sex: z.enum(SURVEY_SEXES).nullable(),
    phase: z.string().nullable(),
    /** 0-10 for every rubric (EXPANDED_2024: (c + 3) / 6 * 10). */
    cleanliness: z.number().min(0).max(10),
    scent: z.number().int().min(0).max(5).nullable(),
    aesthetics: z.number().int().min(0).max(5).nullable(),
    music: z.number().int().min(0).max(5).nullable(),
    toiletries: z.number().int().min(0).max(5).nullable(),
    facilities: z.number().int().min(0).max(20).nullable(),
    total: z.number().int().min(0).max(50).nullable(),
    rasStars: z.number().int().min(1).max(5).nullable(),
    remarks: z.string().nullable(),
    breakdown: ExpandedBreakdownSchema.nullable(),
    raw: z.record(z.string(), z.unknown()),
  })
  .superRefine((s, ctx) => {
    const pilotCols = [s.scent, s.aesthetics, s.music, s.toiletries, s.facilities, s.total];
    if (s.rubric === 'PILOT_50') {
      if (!Number.isInteger(s.cleanliness)) ctx.addIssue({ code: 'custom', path: ['cleanliness'], message: 'PILOT_50 cleanliness is an integer' });
      if (pilotCols.some((v) => v === null)) ctx.addIssue({ code: 'custom', message: 'PILOT_50 needs every pilot column' });
      if (s.breakdown !== null) ctx.addIssue({ code: 'custom', path: ['breakdown'], message: 'PILOT_50 has no breakdown' });
    } else {
      if (pilotCols.some((v) => v !== null)) ctx.addIssue({ code: 'custom', message: 'pilot columns are null for EXPANDED_2024' });
      if (s.breakdown === null) ctx.addIssue({ code: 'custom', path: ['breakdown'], message: 'EXPANDED_2024 needs a breakdown' });
    }
  });
export type CuratedSurvey = z.infer<typeof CuratedSurveySchema>;

export const CuratedVenueSchema = z.object({
  key: z.string(),
  sourceKey: z.string().startsWith('sheet-venue:'),
  name: z.string().min(1),
  type: z.enum(VENUE_TYPES),
  lines: z.array(z.string()),
  toiletStatus: z.enum(['HAS_TOILETS', 'NONE', 'UNKNOWN', 'USES_NEARBY']),
  note: z.string().nullable(),
  openingHours: OpeningHoursSchema.nullable(),
  geocode: z.object({ strategy: z.enum(['mrt', 'place']), query: z.string() }),
  usesNearbyVenueKey: z.string().nullable(),
});
export type CuratedVenue = z.infer<typeof CuratedVenueSchema>;

export const CuratedToiletSchema = z.object({
  sourceKey: z.string().startsWith('sheet:'),
  venueKey: z.string(),
  location: z.string(),
  label: z.string().nullable(),
  level: z.string().nullable(),
  lines: z.array(z.string()),
  status: z.enum(['ACTIVE', 'RENOVATION', 'CLOSED']),
  tier: z.literal('VERIFIED'),
  areaType: z.literal('UNKNOWN'),
  lastVerifiedAt: isoDate,
  needsResurvey: z.boolean(),
  features: z.array(z.object({ feature: z.enum(FEATURES), present: z.boolean() })),
  surveys: z.array(CuratedSurveySchema),
});
export type CuratedToilet = z.infer<typeof CuratedToiletSchema>;

export const FieldworkSchema = z.object({
  source: z.object({ sheetId: z.string(), observedAt: isoDate, note: z.string() }),
  venues: z.array(CuratedVenueSchema),
  toilets: z.array(CuratedToiletSchema),
});
export type Fieldwork = z.infer<typeof FieldworkSchema>;

export const GeocodedVenueSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  name: z.string().nullable(),
  address: z.string().nullable(),
  postalCode: z.string().nullable(),
  planningArea: z.string().nullable(),
  method: z.enum(['onemap', 'wikidata', 'override']),
  query: z.string(),
  matched: z.string().nullable(),
  candidates: z.number().int(),
});
export const GeocodedSchema = z.record(z.string(), GeocodedVenueSchema);
export type GeocodedVenue = z.infer<typeof GeocodedVenueSchema>;

export const OverrideSchema = z.object({
  /** Replace the OneMap query (and optionally require SEARCHVAL/ADDRESS to contain `pick`). */
  query: z.string().optional(),
  pick: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  name: z.string().optional(),
  address: z.string().optional(),
  postalCode: z.string().optional(),
  reason: z.string().optional(),
});
export const OverridesSchema = z.record(z.string(), OverrideSchema);
export type Override = z.infer<typeof OverrideSchema>;
/**
 * overrides.json `remarkOverrides`: survey key (`Survey.raw._key`, e.g. "survey2:H85/female#2024-08-24T09:23:29+08:00")
 * -> the remark to show instead, or null to blank it. Applied by survey2:normalise; the owner's moderation lever.
 */
export const REMARK_OVERRIDES_KEY = 'remarkOverrides';
export const RemarkOverridesSchema = z.record(z.string(), z.string().nullable());
export type RemarkOverrides = z.infer<typeof RemarkOverridesSchema>;
/**
 * overrides.json `osmOverrides`: OSM toilet sourceKey ("osm:way/1395135421") -> what seed:fieldwork-2024b does with
 * it next to the expanded survey, instead of its own rules: "retire" (delete it), "keep" (never supersede, retire or
 * merge it), or `{ "mergeInto": "<survey2 toilet sourceKey>" }` (move that survey2 toilet onto it, then delete it).
 * import:osm reads it too: a retired or merged toilet is never re-added, a kept one is never deduped.
 */
export const OSM_OVERRIDES_KEY = 'osmOverrides';
export const OsmOverrideSchema = z.union([
  z.enum(['retire', 'keep']),
  z.object({ mergeInto: z.string().startsWith('survey2:') }).strict(),
]);
export type OsmOverride = z.infer<typeof OsmOverrideSchema>;
export const OsmOverridesSchema = z.record(z.string().startsWith('osm:'), OsmOverrideSchema);
export type OsmOverrides = z.infer<typeof OsmOverridesSchema>;

// ───────────────────────────── expanded survey (survey2) ─────────────────────────────

/** How a survey2 venue is geocoded: `postal` = OneMap search by the 6-digit postcode (coffeeshops, hawkers). */
export const SURVEY2_GEOCODE_STRATEGIES = ['mrt', 'place', 'postal'] as const;

/**
 * A venue of the expanded survey: one per Location Code. `key` is the code ("M9", "EW13", "C73") and
 * is the venue key in survey2-venues.geocoded.json / overrides.json / survey2-venue-matches.json.
 */
export const Survey2VenueSchema = CuratedVenueSchema.extend({
  sourceKey: z.string().startsWith('survey2-venue:'),
  /** The Location Code (same as `key`; kept explicit for readability). */
  code: z.string(),
  /** The Location Code Index row as written (premise name may be empty for coffeeshops). */
  premise: z.string().nullable(),
  indexAddress: z.string().nullable(),
  /** Tidied address and postcode from the index ("103 Gangsa Road #01-35, Singapore 670103"), when it has one. */
  address: z.string().nullable(),
  postalCode: z.string().regex(/^\d{6}$/).nullable(),
  geocode: z.object({ strategy: z.enum(SURVEY2_GEOCODE_STRATEGIES), query: z.string(), fallbackQuery: z.string().optional() }),
});
export type Survey2Venue = z.infer<typeof Survey2VenueSchema>;

export const Survey2ToiletSchema = CuratedToiletSchema.extend({
  /** `survey2:<CODE>/<male|female|unisex>[/<level slug or ordinal>]`. */
  sourceKey: z.string().startsWith('survey2:'),
  code: z.string(),
  sex: z.enum(SURVEY_SEXES),
  /** Toilet.accessNote: the location text minus the level (and minus the premise name). */
  accessNote: z.string().nullable(),
  lastVerifiedAt: isoDateOrTime,
  /** Google Drive link from the sheet (not cleared for reuse; see `survey2:photos`). */
  photoUrl: z.string().url().nullable(),
});
export type Survey2Toilet = z.infer<typeof Survey2ToiletSchema>;

export const Fieldwork2024bSchema = z.object({
  source: z.object({ sheetId: z.string(), observedFrom: isoDate, observedTo: isoDate, note: z.string() }),
  venues: z.array(Survey2VenueSchema),
  toilets: z.array(Survey2ToiletSchema),
});
export type Fieldwork2024b = z.infer<typeof Fieldwork2024bSchema>;

/**
 * survey2-venue-matches.json (written by `survey2:match`, hand-editable). An entry with `locked: true`
 * is kept as is on the next run, so the owner can overrule any automatic decision.
 */
export const Survey2VenueMatchSchema = z.object({
  name: z.string(),
  type: z.enum(VENUE_TYPES),
  /** sourceKey of the existing venue to reuse, or null for a new `survey2-venue:<CODE>` venue. */
  existingVenueSourceKey: z.string().nullable(),
  existingVenueName: z.string().nullable().default(null),
  via: z.string(),
  detail: z.string().nullable().default(null),
  /** Distance between our geocode and the matched venue, when both are known. */
  distanceM: z.number().nullable().default(null),
  locked: z.boolean().default(false),
});
export type Survey2VenueMatch = z.infer<typeof Survey2VenueMatchSchema>;
export const Survey2AttachSchema = z.object({
  /** sourceKey of the pilot toilet that this survey2 row is another survey of, or null = a toilet of its own. */
  pilotToiletSourceKey: z.string().nullable(),
  via: z.string(),
  detail: z.string().nullable().default(null),
  locked: z.boolean().default(false),
});
export type Survey2Attach = z.infer<typeof Survey2AttachSchema>;
export const Survey2MatchesSchema = z.object({
  note: z.string().optional(),
  venues: z.record(z.string(), Survey2VenueMatchSchema),
  /** Keyed by survey2 toilet sourceKey; only rows at a matched pilot venue are listed. */
  attach: z.record(z.string(), Survey2AttachSchema).default({}),
});
export type Survey2Matches = z.infer<typeof Survey2MatchesSchema>;

export function loadFieldwork2024b(file = paths.fieldwork2024b): Fieldwork2024b {
  return Fieldwork2024bSchema.parse(readJson(file));
}
export function loadSurvey2Matches(file = paths.survey2Matches): Survey2Matches | null {
  const j = readJsonIfExists(file);
  return j === undefined ? null : Survey2MatchesSchema.parse(j);
}

export const ReviewItemSchema = z.object({
  kind: z.string(),
  key: z.string().optional(),
  message: z.string(),
  resolution: z.string().optional(),
  data: z.unknown().optional(),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
export const Survey2RemarkSchema = z.object({
  /** Survey key, the key for overrides.json `remarkOverrides`. */
  key: z.string(),
  toilet: z.string(),
  venue: z.string(),
  sex: z.enum(SURVEY_SEXES),
  /** As imported (after any override; null = blanked). */
  remark: z.string().nullable(),
  /** The sheet's text, when an override replaced it. */
  original: z.string().optional(),
});
export type Survey2Remark = z.infer<typeof Survey2RemarkSchema>;
export const ReviewSchema = z.object({
  normalise: z.array(ReviewItemSchema).default([]),
  geocode: z.array(ReviewItemSchema).default([]),
  /** survey2:normalise (expanded survey) anomalies. */
  survey2: z.array(ReviewItemSchema).default([]),
  /** survey2:match decisions that need a human look. */
  survey2Match: z.array(ReviewItemSchema).default([]),
  /** geocode of the survey2 venues. */
  survey2Geocode: z.array(ReviewItemSchema).default([]),
  /** Every survey2 survey with a free-text remark, to read in one place (survey2:normalise). */
  survey2Remarks: z.array(Survey2RemarkSchema).default([]),
  /**
   * seed:fieldwork-2024b: OSM toilets it kept within 45 m of a survey2 toilet, floor merges it could not decide, and
   * unused overrides.json `osmOverrides`; each overridable there by its OSM sourceKey (`key`).
   */
  survey2OsmNear: z.array(ReviewItemSchema).default([]),
});
export type Review = z.infer<typeof ReviewSchema>;

export function loadFieldwork(file = paths.fieldwork): Fieldwork {
  return FieldworkSchema.parse(readJson(file));
}
export function loadGeocoded(file = paths.geocoded): Record<string, GeocodedVenue> {
  return GeocodedSchema.parse(readJsonIfExists(file) ?? {});
}
/** Venue-key overrides (everything except `remarkOverrides` and `osmOverrides`). */
export function loadOverrides(file = paths.overrides): Record<string, Override> {
  const all = (readJsonIfExists(file) ?? {}) as Record<string, unknown>;
  return OverridesSchema.parse(Object.fromEntries(Object.entries(all).filter(([k]) => k !== REMARK_OVERRIDES_KEY && k !== OSM_OVERRIDES_KEY)));
}
export function loadRemarkOverrides(file = paths.overrides): RemarkOverrides {
  const all = (readJsonIfExists(file) ?? {}) as Record<string, unknown>;
  return RemarkOverridesSchema.parse(all[REMARK_OVERRIDES_KEY] ?? {});
}
export function loadOsmOverrides(file = paths.overrides): OsmOverrides {
  const all = (readJsonIfExists(file) ?? {}) as Record<string, unknown>;
  return OsmOverridesSchema.parse(all[OSM_OVERRIDES_KEY] ?? {});
}
export function loadReview(file = paths.review): Review {
  return ReviewSchema.parse(readJsonIfExists(file) ?? {});
}
