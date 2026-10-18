import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Feature, ToiletTier } from '../generated/prisma/enums.js';
import {
  AreaTypeSchema,
  ToiletDetailSchema,
  ToiletPinSchema,
  ToiletSummarySchema,
  commaList,
  lat,
  lng,
  queryBool,
} from './toilet.schemas.js';

export const NearbyQuerySchema = z.object({
  lat,
  lng,
  radius: z.coerce.number().positive().max(5000).default(1000),
  features: commaList(Feature).optional(),
  tier: commaList(ToiletTier).optional(),
  areaType: AreaTypeSchema.optional(),
  openNow: queryBool.optional(),
  includePending: queryBool.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export class NearbyQueryDto extends createZodDto(NearbyQuerySchema) {}

export const InBoundsQuerySchema = z
  .object({
    minLat: lat,
    maxLat: lat,
    minLng: lng,
    maxLng: lng,
    features: commaList(Feature).optional(),
    tier: commaList(ToiletTier).optional(),
    includePending: queryBool.optional(),
  })
  .refine((q) => q.minLat <= q.maxLat && q.minLng <= q.maxLng, {
    message: 'min must be <= max',
  });
export class InBoundsQueryDto extends createZodDto(InBoundsQuerySchema) {}

export const LeaderboardQuerySchema = z.object({ area: z.string().trim().min(1).max(100).optional() });
export class LeaderboardQueryDto extends createZodDto(LeaderboardQuerySchema) {}

export class ToiletSummaryListDto extends createZodDto(
  z.object({ items: z.array(ToiletSummarySchema) }),
) {}
export class ToiletPinListDto extends createZodDto(z.object({ items: z.array(ToiletPinSchema) })) {}
// Root DTO schemas must not carry a meta id (nestjs-zod would emit it twice), hence `.shape`.
export class ToiletDetailDto extends createZodDto(z.object(ToiletDetailSchema.shape)) {}
export class ToiletLeaderboardDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({ rank: z.number().int(), toilet: ToiletSummarySchema, score: z.number() }),
    ),
    areas: z.array(z.string()),
  }),
) {}
