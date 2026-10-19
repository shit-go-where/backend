import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ToiletSummarySchema, VenueToiletStatusSchema } from '../toilets/toilet.schemas.js';

export const StationLineSchema = z.object({ code: z.string(), name: z.string() }).meta({ id: 'StationLine' });

export const StationSummarySchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    lines: z.array(StationLineSchema),
    lat: z.number(),
    lng: z.number(),
    /** HAS_TOILETS, NONE (no toilet in the station) or USES_NEARBY (uses the one next door). */
    toiletStatus: VenueToiletStatusSchema,
    /** ACTIVE toilets inside the station. */
    toiletCount: z.number().int(),
    verifiedCount: z.number().int(),
    bestScore: z.number().nullable(),
    lastVerifiedAt: z.string().nullable(),
    /** Has something worth a search result: toilets, or a definite "no toilet here" answer. */
    indexable: z.boolean(),
  })
  .meta({ id: 'StationSummary' });
export type StationSummary = z.infer<typeof StationSummarySchema>;

export const StationNearbySchema = z
  .object({ toilet: ToiletSummarySchema, distanceM: z.number().int() })
  .meta({ id: 'StationNearby' });

// No meta id: it is only ever a root DTO.
export const StationDetailSchema = z.object({
  ...StationSummarySchema.shape,
  /** Venue note, e.g. "Use the toilets at HDB Hub" for USES_NEARBY. */
  note: z.string().nullable(),
  area: z.object({ slug: z.string(), name: z.string() }).nullable(),
  /** In the station: ACTIVE first, then CLOSED / RENOVATION. Never PENDING. */
  toilets: z.array(ToiletSummarySchema),
  /** ACTIVE toilets at other places within 400 m, nearest first, at most 5. */
  nearby: z.array(StationNearbySchema),
});
export type StationDetail = z.infer<typeof StationDetailSchema>;

export const LineRowSchema = z
  .object({
    rank: z.number().int(),
    code: z.string(),
    name: z.string(),
    stations: z.number().int(),
    stationsWithToilets: z.number().int(),
    scoredStations: z.number().int(),
    /** Mean of each station's best toilet score. */
    avgScore: z.number().nullable(),
    /** % of the line's Verified + Community toilets confirmed within 90 days. */
    freshPct: z.number().nullable(),
    checkInsWeek: z.number().int(),
  })
  .meta({ id: 'LineRow' });

export class StationListDto extends createZodDto(z.object({ items: z.array(StationSummarySchema) })) {}
export class StationDetailDto extends createZodDto(StationDetailSchema) {}
export class LineBoardDto extends createZodDto(z.object({ items: z.array(LineRowSchema) })) {}
