import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  AreaTypeSchema,
  FeatureSchema,
  ToiletSummarySchema,
  VenueToiletStatusSchema,
  lat,
  lng,
} from '../toilets/toilet.schemas.js';
import { PURPOSES } from './purposes.js';

const weight = z.number().min(0).max(1);
export const PurposeSchema = z.enum(PURPOSES).meta({ id: 'Purpose' });

export const RecommendBodySchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  urgent: z.boolean().optional(),
  /** Why they're going: soft preferences on top of `require`. */
  purpose: PurposeSchema.optional(),
  require: z.array(FeatureSchema).max(40).optional(),
  areaType: AreaTypeSchema.optional(),
  openNow: z.boolean().optional(),
  radiusM: z.number().positive().max(5000).optional(),
  weights: z
    .object({ distance: weight.optional(), cleanliness: weight.optional(), freshness: weight.optional() })
    .optional(),
});
export class RecommendBodyDto extends createZodDto(RecommendBodySchema) {}

const LatLngTuple = z.tuple([z.number(), z.number()]);
const RouteSource = z.enum(['onemap', 'estimate']);

export class RecommendResponseDto extends createZodDto(
  z
    .object({
      items: z.array(
        z.object({
          toilet: ToiletSummarySchema,
          score: z.number(),
          walkSeconds: z.number(),
          walkDistanceM: z.number(),
          reasons: z.array(z.string()),
          route: z.object({ polyline: z.array(LatLngTuple), source: RouteSource }).nullable(),
          /** A pending community toilet nobody has confirmed yet: label it "Unconfirmed" (calm mode only). */
          unconfirmed: z.boolean(),
        }),
      ),
      searchedRadiusM: z.number(),
      skippedVenues: z.array(
        z.object({
          name: z.string(),
          toiletStatus: VenueToiletStatusSchema,
          note: z.string().nullable(),
          distanceM: z.number(),
        }),
      ),
    }),
) {}

export const WalkQuerySchema = z.object({ fromLat: lat, fromLng: lng, toLat: lat, toLng: lng });
export class WalkQueryDto extends createZodDto(WalkQuerySchema) {}

export class WalkResponseDto extends createZodDto(
  z.object({
    distanceM: z.number(),
    durationS: z.number(),
    polyline: z.array(LatLngTuple),
    source: RouteSource,
  }),
) {}

export const GeoSearchQuerySchema = z.object({ q: z.string().trim().min(1).max(100) });
export class GeoSearchQueryDto extends createZodDto(GeoSearchQuerySchema) {}

export class GeoSearchResponseDto extends createZodDto(
  z.object({
    items: z.array(z.object({ name: z.string(), address: z.string(), lat: z.number(), lng: z.number() })),
  }),
) {}
