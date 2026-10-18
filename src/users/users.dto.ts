import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PointReason, Role } from '../generated/prisma/enums.js';

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

export const BadgeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  awardedAt: z.string().optional(),
});

export const MeSchema = z.object({
  id: z.string(),
  email: z.string(),
  handle: z.string().nullable(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  role: z.enum(Role),
  trustScore: z.number().int(),
  leaderboardOptIn: z.boolean(),
  points: z.number().int(),
  badges: z.array(BadgeSchema),
  needsHandle: z.boolean(),
});
export type Me = z.infer<typeof MeSchema>;
export class MeDto extends createZodDto(MeSchema) {}

export const UpdateMeSchema = z.object({
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(HANDLE_RE, 'Handle must be 3-20 characters: a-z, 0-9, _')
    .optional(),
  displayName: z.string().trim().min(1).max(50).optional(),
  leaderboardOptIn: z.boolean().optional(),
});
export class UpdateMeDto extends createZodDto(UpdateMeSchema) {}

export const ActivityQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export class ActivityQueryDto extends createZodDto(ActivityQuerySchema) {}

export const ActivityPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      delta: z.number().int(),
      reason: z.enum(PointReason),
      refId: z.string(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export class ActivityPageDto extends createZodDto(ActivityPageSchema) {}
