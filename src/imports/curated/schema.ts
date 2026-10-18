import { z } from 'zod';
import { readJson, readJsonIfExists } from '../lib/files.js';
import { paths } from '../lib/paths.js';

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

export const CuratedSurveySchema = z.object({
  /** Deterministic key, stored in Survey.raw._key so re-seeding matches the same row. */
  key: z.string(),
  surveyedAt: isoDate,
  phase: z.string().nullable(),
  cleanliness: z.number().int().min(0).max(10),
  scent: z.number().int().min(0).max(5),
  aesthetics: z.number().int().min(0).max(5),
  music: z.number().int().min(0).max(5),
  toiletries: z.number().int().min(0).max(5),
  facilities: z.number().int().min(0).max(20),
  total: z.number().int().min(0).max(50),
  rasStars: z.number().int().min(1).max(5).nullable(),
  remarks: z.string().nullable(),
  raw: z.record(z.string(), z.unknown()),
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

export const ReviewItemSchema = z.object({
  kind: z.string(),
  key: z.string().optional(),
  message: z.string(),
  resolution: z.string().optional(),
  data: z.unknown().optional(),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
export const ReviewSchema = z.object({
  normalise: z.array(ReviewItemSchema).default([]),
  geocode: z.array(ReviewItemSchema).default([]),
});
export type Review = z.infer<typeof ReviewSchema>;

export function loadFieldwork(file = paths.fieldwork): Fieldwork {
  return FieldworkSchema.parse(readJson(file));
}
export function loadGeocoded(file = paths.geocoded): Record<string, GeocodedVenue> {
  return GeocodedSchema.parse(readJsonIfExists(file) ?? {});
}
export function loadOverrides(file = paths.overrides): Record<string, Override> {
  return OverridesSchema.parse(readJsonIfExists(file) ?? {});
}
export function loadReview(file = paths.review): Review {
  return ReviewSchema.parse(readJsonIfExists(file) ?? {});
}
