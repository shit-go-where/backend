import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { AreaType, DataSource, Feature, Role, ToiletStatus } from '../generated/prisma/enums.js';

const ok = z.object({ ok: z.literal(true) });
export class AdminOkDto extends createZodDto(ok) {}

export const FlagsQuerySchema = z.object({
  resolved: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export class FlagsQueryDto extends createZodDto(FlagsQuerySchema) {}

export const AdminFlagListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      reason: z.string(),
      createdAt: z.string(),
      resolved: z.boolean(),
      resolutionNote: z.string().nullable(),
      toilet: z.object({ id: z.string(), label: z.string().nullable(), venueName: z.string() }),
      user: z.object({ handle: z.string().nullable() }),
    }),
  ),
});
export class AdminFlagListDto extends createZodDto(AdminFlagListSchema) {}

/** Optional reply to the reporter: shown in their /me and sent by the bot if they linked Telegram. */
// A bodyless POST (no reply) arrives as undefined.
export const ResolveFlagSchema = z.preprocess((v) => v ?? {}, z.object({ note: z.string().trim().max(500).optional() }));
export class ResolveFlagDto extends createZodDto(ResolveFlagSchema) {}

export const PendingPhotoListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      thumbUrl: z.string().nullable(),
      createdAt: z.string(),
      toiletId: z.string().nullable(),
      submissionId: z.string().nullable(),
      reviewId: z.string().nullable(),
      approvals: z.number().int(),
    }),
  ),
});
export class PendingPhotoListDto extends createZodDto(PendingPhotoListSchema) {}

export const PhotoApprovalSchema = z.object({
  approved: z.boolean(),
  approvals: z.number().int(),
});
export class PhotoApprovalDto extends createZodDto(PhotoApprovalSchema) {}

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

export const AdminToiletPatchSchema = z
  .object({
    status: z.enum(ToiletStatus).optional(),
    label: nullableText(200),
    areaType: z.enum(AreaType).optional(),
    level: nullableText(20),
    accessNote: nullableText(500),
    needsResurvey: z.boolean().optional(),
    features: z.partialRecord(z.enum(Feature), z.boolean()).optional(),
  })
  .strict();
export class AdminToiletPatchDto extends createZodDto(AdminToiletPatchSchema) {}

export class AdminIdDto extends createZodDto(z.object({ id: z.string() })) {}

export const RolePatchSchema = z.object({ role: z.enum(Role) });
export class RolePatchDto extends createZodDto(RolePatchSchema) {}
export class RoleResultDto extends createZodDto(z.object({ id: z.string(), role: z.enum(Role) })) {}

export const ImportRunListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      source: z.enum(DataSource),
      command: z.string(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      inserted: z.number().int(),
      updated: z.number().int(),
      skipped: z.number().int(),
      log: z.unknown(),
    }),
  ),
});
export class ImportRunListDto extends createZodDto(ImportRunListSchema) {}

export const DataQualitySchema = z.object({
  counts: z.object({
    toilets: z.number().int(),
    venues: z.number().int(),
    pending: z.number().int(),
    /** Submissions waiting for a moderator: expired without confirmation, or an auto-published toilet flagged twice. */
    escalated: z.number().int(),
    flagsOpen: z.number().int(),
    photosPending: z.number().int(),
    noFeatures: z.number().int(),
    stale365d: z.number().int(),
    needsResurvey: z.number().int(),
    unknownAreaType: z.number().int(),
  }),
});
export class DataQualityDto extends createZodDto(DataQualitySchema) {}

export const JOB_NAMES = ['expire-submissions', 'archive-status', 'recompute-scores', 'metrics'] as const;
export type JobName = (typeof JOB_NAMES)[number];

export const JobResultSchema = z.object({ ok: z.literal(true), affected: z.number().int() });
export class JobResultDto extends createZodDto(JobResultSchema) {}
