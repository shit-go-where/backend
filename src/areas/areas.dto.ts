import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ToiletSummarySchema, VenueLiteSchema, VenueTypeSchema } from '../toilets/toilet.schemas.js';
import { REGIONS } from './regions.js';

export const RegionSchema = z.enum(REGIONS).meta({ id: 'Region' });

export const AreaSummarySchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    region: RegionSchema.nullable(),
    /** ACTIVE toilets only. */
    toiletCount: z.number().int(),
    verifiedCount: z.number().int(),
    /** Places with at least one ACTIVE toilet. */
    venueCount: z.number().int(),
    /** Enough toilets to be worth a search engine's time. */
    indexable: z.boolean(),
  })
  .meta({ id: 'AreaSummary' });
export type AreaSummary = z.infer<typeof AreaSummarySchema>;

export const AreaVenueSchema = VenueLiteSchema.extend({
  address: z.string().nullable(),
  /** For places with no address: the closest named place (in any area), so look-alike rows can be told apart. */
  near: z.object({ name: z.string(), type: VenueTypeSchema, distanceM: z.number().int() }).nullable(),
  /** ACTIVE first, then CLOSED / RENOVATION. Never PENDING. */
  toilets: z.array(ToiletSummarySchema),
}).meta({ id: 'AreaVenue' });
export type AreaVenue = z.infer<typeof AreaVenueSchema>;

// No meta id: it is only ever a root DTO, and nestjs-zod would emit a root id twice.
export const AreaDetailSchema = z.object({
  ...AreaSummarySchema.shape,
  pendingCount: z.number().int(),
  /** Where "See on map" should drop the map: the area's namesake MRT station, else the place nearest the middle. */
  center: z.object({ lat: z.number(), lng: z.number() }).nullable(),
  /** Best first: verified and cleaner places lead. */
  venues: z.array(AreaVenueSchema),
  /** Places marked as having no toilet, or using one next door. */
  noToiletVenues: z.array(VenueLiteSchema),
});
export type AreaDetail = z.infer<typeof AreaDetailSchema>;

export class AreaListDto extends createZodDto(z.object({ items: z.array(AreaSummarySchema) })) {}
export class AreaDetailDto extends createZodDto(AreaDetailSchema) {}
