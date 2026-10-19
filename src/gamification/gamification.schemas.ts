import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { Feature } from '../generated/prisma/enums.js';

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

export const BadgeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  awardedAt: z.string().optional(),
});
export type BadgeView = z.infer<typeof BadgeSchema>;
export class BadgeListDto extends createZodDto(z.object({ items: z.array(BadgeSchema) })) {}

export const CheckInSchema = z.object({ lat, lng });
export class CheckInDto extends createZodDto(CheckInSchema) {}

export const CheckInResultSchema = z.object({
  id: z.string(),
  distanceM: z.number().int(),
  pointsAwarded: z.number().int(),
  newBadges: z.array(BadgeSchema),
  verifyPrompt: z.array(z.enum(Feature)),
  /** This check-in counted as a confirmation of a new toilet someone else added. */
  confirmedPending: z.boolean(),
  /** ...and that confirmation put it live. */
  wentLive: z.boolean(),
  /** Signed out: points this device earned and will be paid on sign-in. Always 0 when signed in. */
  bankedPoints: z.number().int(),
});
export type CheckInResult = z.infer<typeof CheckInResultSchema>;
export class CheckInResultDto extends createZodDto(CheckInResultSchema) {}

export const VerifySchema = z.object({
  lat,
  lng,
  accurate: z.boolean(),
  note: z.string().trim().min(1).max(500).optional(),
});
export class VerifyDto extends createZodDto(VerifySchema) {}
export class OkDto extends createZodDto(z.object({ ok: z.literal(true) })) {}

export const PassportSchema = z.object({
  stamped: z.number().int(),
  total: z.number().int(),
  stations: z.array(
    z.object({
      venueId: z.string(),
      name: z.string(),
      lines: z.array(z.string()),
      stampedAt: z.string().nullable(),
    }),
  ),
});
export class PassportDto extends createZodDto(PassportSchema) {}

export const LeaderboardQuerySchema = z.object({ scope: z.enum(['week', 'all']).default('week') });
export class LeaderboardQueryDto extends createZodDto(LeaderboardQuerySchema) {}

export const LeaderboardSchema = z.object({
  items: z.array(
    z.object({
      rank: z.number().int(),
      handle: z.string(),
      avatarUrl: z.string().nullable(),
      points: z.number().int(),
    }),
  ),
  me: z.object({ rank: z.number().int().nullable(), points: z.number().int() }).nullable(),
});
export type Leaderboard = z.infer<typeof LeaderboardSchema>;
export class LeaderboardDto extends createZodDto(LeaderboardSchema) {}
