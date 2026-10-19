/** zod schemas for finder responses and queries. Shapes follow API_CONTRACT.md. */
import { z } from 'zod';
import {
  AreaType,
  Feature,
  StatusKind,
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
  })
  .meta({ id: 'ToiletPin' });
export type ToiletPin = z.infer<typeof ToiletPinSchema>;

export const SurveySchema = z
  .object({
    id: z.string(),
    surveyedAt: z.string(),
    phase: z.string().nullable(),
    cleanliness: z.number(),
    scent: z.number(),
    aesthetics: z.number(),
    music: z.number(),
    toiletries: z.number(),
    facilities: z.number(),
    total: z.number(),
    rasStars: z.number().nullable(),
    remarks: z.string().nullable(),
  })
  .meta({ id: 'Survey' });

export const ReviewSchema = z
  .object({
    id: z.string(),
    cleanliness: z.number().int(),
    comment: z.string().nullable(),
    createdAt: z.string(),
    user: z.object({ handle: z.string().nullable(), avatarUrl: z.string().nullable() }),
    photos: z.array(PhotoRefSchema),
  })
  .meta({ id: 'Review' });
export type Review = z.infer<typeof ReviewSchema>;

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
    reviews: z.array(ReviewSchema),
    photos: z.array(PhotoRefSchema),
    myReview: ReviewSchema.nullable(),
    source: z.string(),
    attribution: z.string().nullable(),
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
