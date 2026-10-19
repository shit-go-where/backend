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
  /** Show "Last checked by @handle" on toilets this person verified. */
  verifierCredit: z.boolean(),
  points: z.number().int(),
  badges: z.array(BadgeSchema),
  needsHandle: z.boolean(),
  /** When the handle can next be changed (once every 30 days); null = now. */
  handleChangeableAt: z.string().nullable(),
  /** Progress to Trusted: trust points (verified actions) against the threshold. */
  trust: z.object({ score: z.number().int(), threshold: z.number().int(), isTrusted: z.boolean() }),
  /** Open submissions from the last 14 days against the cap, so /add can warn up front. */
  openSubmissions: z.object({ count: z.number().int(), limit: z.number().int() }),
  /** Since lastSeenActivityAt (or sign-up): submissions decided, badges earned, points earned. */
  unseen: z.object({
    resolvedSubmissions: z.number().int(),
    badges: z.number().int(),
    points: z.number().int(),
    /** Routes other people started to toilets you helped, on Singapore days since your last visit. */
    routed: z.number().int(),
  }),
  /**
   * What your contributions did (GROWTH.md 1.3). `toilets`: toilets you added, last verified, or
   * checked in at in the last 90 days. `routedWeek`: routes started to them in the last 7 days.
   */
  impact: z.object({ toilets: z.number().int(), routedWeek: z.number().int() }),
  lastSeenActivityAt: z.string().nullable(),
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
  verifierCredit: z.boolean().optional(),
});
export class UpdateMeDto extends createZodDto(UpdateMeSchema) {}

export class ActivitySeenDto extends createZodDto(z.object({ ok: z.literal(true), seenAt: z.string() })) {}

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
