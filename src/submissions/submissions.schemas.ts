import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import {
  AreaType,
  Feature,
  SubmissionKind,
  SubmissionState,
  VenueToiletStatus,
  VenueType,
  VoteValue,
} from '../generated/prisma/enums.js';
import { RESOLUTION_CODES } from './resolution-codes.js';

/* ─────────────── shared building blocks ─────────────── */

export const FeatureSchema = z.enum(Feature);
export const FeatureMapSchema = z.partialRecord(FeatureSchema, z.boolean());
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const shortText = (max: number) => z.string().trim().min(1).max(max);

/* ─────────────── payloads (stored in Submission.payload) ─────────────── */

export const NewToiletPayloadSchema = z.object({
  venueId: z.string().min(1).optional(),
  newVenue: z.object({ name: shortText(120), type: z.enum(VenueType) }).optional(),
  label: shortText(120).optional(),
  lat,
  lng,
  level: shortText(20).optional(),
  areaType: z.enum(AreaType).optional(),
  accessNote: shortText(500).optional(),
  features: FeatureMapSchema,
  // Optional: peers nearby confirm a new toilet either way, and a photo shouldn't block one (PRODUCT.md).
  photoIds: z.array(z.string().min(1)).max(10).default([]),
  /** Added when answering NEEDS_INFO (PATCH /submissions/:id). */
  note: shortText(1000).optional(),
});
export type NewToiletPayload = z.infer<typeof NewToiletPayloadSchema>;

export const EditToiletPayloadSchema = z.object({
  changes: z
    .object({
      label: shortText(120).optional(),
      level: shortText(20).optional(),
      areaType: z.enum(AreaType).optional(),
      accessNote: shortText(500).optional(),
      features: FeatureMapSchema.optional(),
    })
    .refine(
      (c) =>
        [c.label, c.level, c.areaType, c.accessNote].some((v) => v !== undefined) ||
        Object.keys(c.features ?? {}).length > 0,
      { message: 'changes must contain at least one change' },
    ),
  photoIds: z.array(z.string().min(1)).max(10).optional(),
  note: shortText(1000).optional(),
});
export type EditToiletPayload = z.infer<typeof EditToiletPayloadSchema>;

export const CloseToiletPayloadSchema = z.object({
  status: z.enum(['CLOSED', 'RENOVATION']),
  reason: shortText(500),
  note: shortText(1000).optional(),
});
export type CloseToiletPayload = z.infer<typeof CloseToiletPayloadSchema>;

/** Any stored payload (used for responses). */
export const SubmissionPayloadSchema = z.union([
  NewToiletPayloadSchema,
  EditToiletPayloadSchema,
  CloseToiletPayloadSchema,
]);

/* ─────────────── requests ─────────────── */

const submissionBase = {
  toiletId: z.string().min(1).optional(),
  lat: lat.optional(),
  lng: lng.optional(),
  /** Skip the duplicate guard (NEW_TOILET) after the user confirmed it is a different toilet. */
  force: z.boolean().optional(),
};

export const CreateSubmissionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(SubmissionKind.NEW_TOILET), payload: NewToiletPayloadSchema, ...submissionBase }),
  z.object({ kind: z.literal(SubmissionKind.EDIT_TOILET), payload: EditToiletPayloadSchema, ...submissionBase }),
  z.object({ kind: z.literal(SubmissionKind.CLOSE_TOILET), payload: CloseToiletPayloadSchema, ...submissionBase }),
]);
export type CreateSubmissionBody = z.infer<typeof CreateSubmissionSchema>;

/**
 * A class cannot `extends` a union type, so this DTO is a plain value used for OpenAPI only
 * (`@ApiBody`); the controller validates with `new ZodValidationPipe(CreateSubmissionSchema)`.
 */
export const CreateSubmissionDto = createZodDto(CreateSubmissionSchema);
// Swagger names the component after the class name.
Object.defineProperty(CreateSubmissionDto, 'name', { value: 'CreateSubmissionDto' });

export const QueueQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().int().min(50).max(20_000).default(3000),
});
export class QueueQueryDto extends createZodDto(QueueQuerySchema) {}

export const VoteSchema = z.object({
  value: z.enum(VoteValue),
  comment: shortText(500).optional(),
  lat: lat.optional(),
  lng: lng.optional(),
});
export class VoteDto extends createZodDto(VoteSchema) {}

export const ResolveSchema = z.object({
  state: z.enum(['APPROVED', 'REJECTED', 'NEEDS_INFO']),
  note: shortText(500).optional(),
});
export class ResolveDto extends createZodDto(ResolveSchema) {}

/** Owner's answer to NEEDS_INFO: more detail, more photos, a corrected level. Puts it back to PENDING. */
export const UpdateSubmissionSchema = z
  .object({
    note: shortText(1000).optional(),
    photoIds: z.array(z.string().min(1)).max(10).optional(),
    level: shortText(20).optional(),
  })
  .refine((b) => b.note !== undefined || b.level !== undefined || (b.photoIds?.length ?? 0) > 0, {
    message: 'Add a note, a photo or a level',
  });
export class UpdateSubmissionDto extends createZodDto(UpdateSubmissionSchema) {}

export const ModeratorQueueQuerySchema = z.object({
  state: z.enum(['pending', 'escalated', 'needs_info', 'all']).default('all'),
});
export class ModeratorQueueQueryDto extends createZodDto(ModeratorQueueQuerySchema) {}

/* ─────────────── responses ─────────────── */

export const PhotoRefSchema = z.object({ id: z.string(), url: z.string(), thumbUrl: z.string().nullable() });

export const VenueLiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(VenueType),
  lines: z.array(z.string()),
  lat: z.number(),
  lng: z.number(),
  toiletStatus: z.enum(VenueToiletStatus),
  note: z.string().nullable(),
});

/** The toilet's values now, for the fields an EDIT_TOILET changes (null feature = no record). */
export const CurrentValuesSchema = z.object({
  label: z.string().nullable().optional(),
  level: z.string().nullable().optional(),
  areaType: z.enum(AreaType).optional(),
  accessNote: z.string().nullable().optional(),
  features: z.partialRecord(FeatureSchema, z.boolean().nullable()).optional(),
});

/** One vote, anonymised: no user id or handle. */
export const ReviewerNoteSchema = z.object({
  value: z.enum(VoteValue),
  note: z.string().nullable(),
  createdAt: z.string(),
  /** Cast within 150 m of the toilet, so it counts toward the nearby quorum. */
  nearby: z.boolean(),
  /** The vote came from a check-in at the toilet. */
  viaCheckIn: z.boolean(),
});

export const SubmissionViewSchema = z.object({
  id: z.string(),
  kind: z.enum(SubmissionKind),
  state: z.enum(SubmissionState),
  payload: SubmissionPayloadSchema,
  /** Submitted within 150 m of the toilet / with at least one photo. */
  onSite: z.boolean(),
  hasPhoto: z.boolean(),
  /** auto: live at once (on site + photo); on_site_check_in: one nearby check-in or vote; nearby_quorum: two. */
  path: z.enum(['auto', 'on_site_check_in', 'nearby_quorum']),
  nearbyApprovals: z.number().int(),
  /** More nearby confirmations needed to go live (0 once decided, or while only a moderator can decide). */
  needed: z.number().int(),
  escalated: z.boolean(),
  /** How far from the toilet the submitter stood, when they shared a location. */
  submitterDistanceM: z.number().int().nullable(),
  reviewerNotes: z.array(ReviewerNoteSchema),
  /** EDIT_TOILET while open: the toilet's current values for the changed fields. */
  current: CurrentValuesSchema.nullable(),
  toilet: z
    .object({ id: z.string(), label: z.string().nullable(), venueName: z.string(), lat: z.number(), lng: z.number() })
    .nullable(),
  venue: VenueLiteSchema.nullable(),
  submittedBy: z.object({ handle: z.string().nullable() }),
  approvals: z.number().int(),
  rejections: z.number().int(),
  createdAt: z.string(),
  expiresAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolution: z.enum(RESOLUTION_CODES).nullable(),
  resolutionText: z.string().nullable(),
  /** A moderator's note on their decision. */
  resolutionNote: z.string().nullable(),
  distanceM: z.number().optional(),
  myVote: z.enum(VoteValue).nullable(),
  photos: z.array(PhotoRefSchema),
  canVote: z.boolean(),
});
export type SubmissionView = z.infer<typeof SubmissionViewSchema>;
export class SubmissionViewDto extends createZodDto(SubmissionViewSchema) {}
export class SubmissionListDto extends createZodDto(z.object({ items: z.array(SubmissionViewSchema) })) {}

export const ModeratorSubmissionSchema = SubmissionViewSchema.extend({
  /** Whole days since it was submitted. */
  ageDays: z.number().int(),
});
export type ModeratorSubmission = z.infer<typeof ModeratorSubmissionSchema>;
export class ModeratorSubmissionListDto extends createZodDto(z.object({ items: z.array(ModeratorSubmissionSchema) })) {}
