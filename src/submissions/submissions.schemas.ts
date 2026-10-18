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
  photoIds: z.array(z.string().min(1)).min(1).max(10),
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
  // Out of scope for v1; accepted by the schema so the API can explain what to do instead.
  z.object({ kind: z.literal(SubmissionKind.NEW_VENUE), payload: z.unknown(), ...submissionBase }),
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

export const SubmissionViewSchema = z.object({
  id: z.string(),
  kind: z.enum(SubmissionKind),
  state: z.enum(SubmissionState),
  payload: SubmissionPayloadSchema,
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
  resolution: z.string().nullable(),
  distanceM: z.number().optional(),
  myVote: z.enum(VoteValue).nullable(),
  photos: z.array(PhotoRefSchema),
  canVote: z.boolean(),
});
export type SubmissionView = z.infer<typeof SubmissionViewSchema>;
export class SubmissionViewDto extends createZodDto(SubmissionViewSchema) {}
export class SubmissionListDto extends createZodDto(z.object({ items: z.array(SubmissionViewSchema) })) {}
