import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PointReason, Role } from '../generated/prisma/enums.js';
import type { Prisma } from '../generated/prisma/client.js';

/** Default point values. See PLAN.md §6.9. */
export const POINTS: Record<PointReason, number> = {
  SUBMISSION_APPROVED: 20,
  REVIEW_POSTED: 5,
  REVIEW_WITH_PHOTO: 5,
  STATUS_CONFIRMED: 2,
  CHECK_IN: 1,
  FIRST_CHECK_IN_AT_TOILET: 3,
  VOTE_MATCHED_OUTCOME: 2,
  SURVEY_COMPLETED: 30,
};

/** Reasons that count toward trust (actions verified by others). */
const TRUST_REASONS = new Set<PointReason>([
  'SUBMISSION_APPROVED',
  'STATUS_CONFIRMED',
  'VOTE_MATCHED_OUTCOME',
  'SURVEY_COMPLETED',
  'REVIEW_WITH_PHOTO',
]);

export const TRUSTED_THRESHOLD = 50;

@Injectable()
export class PointsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent: the same (user, reason, refId) is only ever awarded once.
   * Returns true if points were newly awarded. Pass `tx` to run inside a transaction.
   * Promotes USER -> TRUSTED when trust crosses TRUSTED_THRESHOLD.
   */
  async award(
    userId: string,
    reason: PointReason,
    refId: string,
    opts: { delta?: number; tx?: Prisma.TransactionClient } = {},
  ): Promise<boolean> {
    const db = opts.tx ?? this.prisma;
    const delta = opts.delta ?? POINTS[reason];
    const created = await db.pointsLedger.createMany({
      data: [{ userId, reason, refId, delta }],
      skipDuplicates: true,
    });
    if (created.count === 0) return false;
    if (TRUST_REASONS.has(reason)) {
      const user = await db.user.update({
        where: { id: userId },
        data: { trustScore: { increment: delta } },
        select: { trustScore: true, role: true },
      });
      if (user.role === Role.USER && user.trustScore >= TRUSTED_THRESHOLD) {
        await db.user.update({ where: { id: userId }, data: { role: Role.TRUSTED } });
      }
    }
    return true;
  }
}
