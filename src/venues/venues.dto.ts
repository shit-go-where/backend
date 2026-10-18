import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ToiletSummarySchema, VenueLiteSchema, lat, lng } from '../toilets/toilet.schemas.js';

export const VenueNearbyQuerySchema = z.object({
  lat,
  lng,
  radius: z.coerce.number().positive().max(5000).default(1000),
});
export class VenueNearbyQueryDto extends createZodDto(VenueNearbyQuerySchema) {}

export const VenueSearchQuerySchema = z
  .object({ q: z.string().trim().min(1).max(100), lat: lat.optional(), lng: lng.optional() })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: 'lat and lng must be given together',
  });
export class VenueSearchQueryDto extends createZodDto(VenueSearchQuerySchema) {}

export class VenueNearbyListDto extends createZodDto(
  z.object({
    items: z.array(
      VenueLiteSchema.extend({ distanceM: z.number(), toiletCount: z.number().int() }),
    ),
  }),
) {}
export class VenueLiteListDto extends createZodDto(z.object({ items: z.array(VenueLiteSchema) })) {}
export class VenueDetailDto extends createZodDto(
  VenueLiteSchema.extend({
    address: z.string().nullable(),
    planningArea: z.string().nullable(),
    toilets: z.array(ToiletSummarySchema),
  }),
) {}
