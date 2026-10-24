/** zod schemas for finder responses and queries. Shapes follow API_CONTRACT.md. */
import { z } from 'zod';
import {
  AreaType,
  Feature,
  StatusKind,
  SurveyRubric,
  SurveySex,
  ToiletStatus,
  ToiletTier,
  VenueToiletStatus,
  VenueType,
} from '../generated/prisma/enums.js';

export const FeatureSchema = z.enum(Feature).meta({ id: 'Feature' });
export const VenueTypeSchema = z.enum(VenueType).meta({ id: 'VenueType' });
export const VenueToiletStatusSchema = z.enum(VenueToiletStatus).meta({ id: 'VenueToiletStatus' });
export const ToiletTierSchema = z.enum(ToiletTier).meta({ id: 'ToiletTier' });
export const ToiletStatusSchema = z.enum(ToiletStatus).meta({ id: 'ToiletStatus' });
export const AreaTypeSchema = z.enum(AreaType).meta({ id: 'AreaType' });
export const StatusKindSchema = z.enum(StatusKind).meta({ id: 'StatusKind' });
export const SurveyRubricSchema = z.enum(SurveyRubric).meta({ id: 'SurveyRubric' });
/** Who a toilet (or the toilet a survey looked at) is for. */
export const SexSchema = z.enum(SurveySex).meta({ id: 'Sex' });
/** `sex=MALE|FEMALE` on list endpoints: toilets usable by that sex (its own, unisex or unknown). */
export const SexPreferenceSchema = z.enum(['MALE', 'FEMALE']).meta({ id: 'SexPreference' });

// ───────────────────────────── query helpers ─────────────────────────────

/** "true"/"false"/"1"/"0" query flag. */
export const queryBool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/** Comma-separated enum list, e.g. `features=BIDET,ACCESSIBLE`. */
export function commaList<T extends Record<string, string>>(values: T) {
  return z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values)));
}

export const lat = z.coerce.number().min(-90).max(90);
export const lng = z.coerce.number().min(-180).max(180);

// ───────────────────────────── response pieces ─────────────────────────────

const OpeningPeriodSchema = z.object({
  days: z.array(z.number().int()),
  open: z.string(),
  close: z.string(),
});

export const OpeningHoursSchema = z
  .union([
    z.object({ type: z.literal('always') }),
    z.object({
      type: z.literal('weekly'),
      periods: z.array(OpeningPeriodSchema),
      inferred: z.boolean().optional(),
    }),
    z.object({ type: z.literal('osm'), value: z.string() }),
  ])
  .meta({ id: 'OpeningHours' });

export const PhotoRefSchema = z
  .object({ id: z.string(), url: z.string(), thumbUrl: z.string().nullable() })
  .meta({ id: 'PhotoRef' });

export const VenueLiteSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: VenueTypeSchema,
    lines: z.array(z.string()),
    lat: z.number(),
    lng: z.number(),
    toiletStatus: VenueToiletStatusSchema,
    note: z.string().nullable(),
  })
  .meta({ id: 'VenueLite' });

export const ActiveStatusSchema = z
  .object({ kind: StatusKindSchema, count: z.number().int(), latestAt: z.string() })
  .meta({ id: 'ActiveStatus' });

const toiletSummaryShape = {
  id: z.string(),
  label: z.string().nullable(),
  venue: VenueLiteSchema,
  lat: z.number(),
  lng: z.number(),
  level: z.string().nullable(),
  areaType: AreaTypeSchema,
  tier: ToiletTierSchema,
  status: ToiletStatusSchema,
  features: z.array(FeatureSchema),
  /** From the MALE / FEMALE / UNISEX features: UNISEX if present, else MALE or FEMALE when only one is; else null. */
  sex: SexSchema.nullable(),
  scoreCleanliness: z.number().nullable(),
  surveyTotal: z.number().nullable(),
  rasStars: z.number().nullable(),
  reviewCount: z.number().int(),
  /** Distinct signed-in people who have been there (the submitter plus first check-ins within 150 m). */
  seenBy: z.number().int(),
  activeStatus: z.array(ActiveStatusSchema),
  lastVerifiedAt: z.string().nullable(),
  needsResurvey: z.boolean(),
  openNow: z.boolean().nullable(),
  photoThumb: z.string().nullable(),
  distanceM: z.number().optional(),
  walkSecondsEstimate: z.number().optional(),
};

export const ToiletSummarySchema = z.object(toiletSummaryShape).meta({ id: 'ToiletSummary' });
export type ToiletSummary = z.infer<typeof ToiletSummarySchema>;

export const ToiletPinSchema = z
  .object({
    id: z.string(),
    lat: z.number(),
    lng: z.number(),
    tier: ToiletTierSchema,
    status: ToiletStatusSchema,
    scoreCleanliness: z.number().nullable(),
    hasIssue: z.boolean(),
    venueType: VenueTypeSchema,
    venueId: z.string(),
    /** Normalised ("B1", "L3", "M", "B1; L3"), or free text when it couldn't be read; null when unknown. */
    level: z.string().nullable(),
    /** Sort key for level: B2 = -2, L1 = 1, M = 1.5, a list = its lowest; null when unknown. */
    levelOrder: z.number().nullable(),
    /** As on ToiletSummary. */
    sex: SexSchema.nullable(),
  })
  .meta({ id: 'ToiletPin' });
export type ToiletPin = z.infer<typeof ToiletPinSchema>;

export const SurveyScaleItemSchema = z
  .object({
    kind: z.literal('scale'),
    key: z.string(),
    label: z.string(),
    value: z.number(),
    min: z.number(),
    max: z.number(),
  })
  .meta({ id: 'SurveyScaleItem' });

export const SurveyChecklistItemSchema = z
  .object({
    kind: z.literal('checklist'),
    key: z.string(),
    label: z.string(),
    /** Display labels of the ticked items, in checklist order. */
    checked: z.array(z.string()),
    /** Items on the checklist. */
    total: z.number().int(),
  })
  .meta({ id: 'SurveyChecklistItem' });

/** Display-ready, so clients never need to know the rubric (built in survey-items.ts). */
export const SurveySchema = z
  .object({
    id: z.string(),
    surveyedAt: z.string(),
    rubric: SurveyRubricSchema,
    /** The toilet the surveyor looked at; null when not recorded. */
    sex: SexSchema.nullable(),
    /** 0-10 for every rubric (this is what feeds scoreCleanliness). */
    cleanliness: z.number(),
    total: z.number().nullable(),
    /** 50 for PILOT_50; null when the rubric has no total. */
    totalMax: z.number().nullable(),
    rasStars: z.number().nullable(),
    phase: z.string().nullable(),
    remarks: z.string().nullable(),
    items: z.array(z.discriminatedUnion('kind', [SurveyScaleItemSchema, SurveyChecklistItemSchema])),
  })
  .meta({ id: 'Survey' });
export type Survey = z.infer<typeof SurveySchema>;

export const ReviewSchema = z
  .object({
    id: z.string(),
    cleanliness: z.number().int(),
    comment: z.string().nullable(),
    createdAt: z.string(),
    /** `avatarUrl` is always null (kept for contract compatibility; profile pictures are not public). */
    user: z.object({ handle: z.string().nullable(), avatarUrl: z.string().nullable() }),
    photos: z.array(PhotoRefSchema),
  })
  .meta({ id: 'Review' });
export type Review = z.infer<typeof ReviewSchema>;

/** Another toilet at the same place, for the "other toilets in this building" row. */
export const ToiletSiblingSchema = z
  .object({
    id: z.string(),
    label: z.string().nullable(),
    level: z.string().nullable(),
    levelOrder: z.number().nullable(),
    status: ToiletStatusSchema,
    /** As on ToiletSummary. */
    sex: SexSchema.nullable(),
  })
  .meta({ id: 'ToiletSibling' });

/** One survey on record, for "2 surveys on record (Mar and Oct 2024)". */
export const SurveyDateSchema = z
  .object({
    surveyedAt: z.string(),
    rubric: SurveyRubricSchema,
  })
  .meta({ id: 'SurveyDate' });

export const ToiletDetailSchema = z
  .object({
    ...toiletSummaryShape,
    venue: VenueLiteSchema.extend({
      address: z.string().nullable(),
      planningArea: z.string().nullable(),
    }),
    accessNote: z.string().nullable(),
    nearestExit: z.string().nullable(),
    /** "120 m from Tampines MRT": the nearest named place within 1.5 km, only when the venue has no address. */
    near: z.string().nullable(),
    /** The open NEW_TOILET submission behind a pending toilet, so its page can link to that review card. */
    openSubmissionId: z.string().nullable(),
    openingHours: OpeningHoursSchema.nullable(),
    featureDetails: z.array(
      z.object({
        feature: FeatureSchema,
        present: z.boolean(),
        source: z.string(),
        observedAt: z.string(),
      }),
    ),
    latestSurvey: SurveySchema.nullable(),
    surveyCount: z.number().int(),
    /** Every survey of this toilet, newest first (latestSurvey is the first). */
    surveys: z.array(SurveyDateSchema),
    reviews: z.array(ReviewSchema),
    photos: z.array(PhotoRefSchema),
    myReview: ReviewSchema.nullable(),
    /** Who last tapped "still accurate" on site, by handle (GROWTH.md 1.7). Null if unknown or they opted out. */
    verifiedBy: z.object({ handle: z.string() }).nullable(),
    source: z.string(),
    attribution: z.string().nullable(),
    /** The other ACTIVE toilets at the same venue, lowest level first (unknown levels last). */
    siblings: z.array(ToiletSiblingSchema),
  })
  .meta({ id: 'ToiletDetail' });
export type ToiletDetail = z.infer<typeof ToiletDetailSchema>;

export const StatusReportSchema = z
  .object({
    id: z.string(),
    kind: StatusKindSchema,
    confirmations: z.number().int(),
    createdAt: z.string(),
    expiresAt: z.string(),
    confirmedByMe: z.boolean(),
    /**
     * A signed-out Closed / Broken report nobody has backed up yet: shown, but it does not affect
     * activeStatus, pins or routing until a signed-in person confirms or reports the same, or a
     * second device does.
     */
    unconfirmed: z.boolean(),
  })
  .meta({ id: 'StatusReport' });
export type StatusReportView = z.infer<typeof StatusReportSchema>;
