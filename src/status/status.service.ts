import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { StatusReport } from '../generated/prisma/client.js';
import type { StatusKind } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PointsService } from '../gamification/points.service.js';
import type { StatusReportView } from '../toilets/toilet.schemas.js';
import { isUnconfirmed } from './unconfirmed.js';
import { sgtDayStart } from '../gamification/sgt.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { WEB, baseProps, distinctIdFor, type AnalyticsContext } from '../analytics/analytics.js';

const HOUR = 3_600_000;
export const STATUS_TTL_MS = 2 * HOUR;
export const CLOSED_TTL_MS = 24 * HOUR;
/** Signed-out reports are shorter-lived, whatever the kind (PLAN.md §12 E4). */
export const ANON_STATUS_TTL_MS = HOUR;
export const DEDUPE_WINDOW_MS = 30 * 60_000;
export const CONFIRM_EXTEND_MS = HOUR;
export const CONFIRM_CAP_MS = 6 * HOUR;
/**
 * STATUS_CONFIRMED counts toward trust, so one confirmer can earn a given reporter it at most this
 * many times per Singapore day. Without a cap two accounts (one reporting, one confirming) reached
 * TRUSTED in a few minutes.
 */
export const CONFIRM_POINTS_PER_PAIR_PER_DAY = 1;

export const ttlFor = (kind: StatusKind, anonymous = false) =>
  anonymous ? ANON_STATUS_TTL_MS : kind === 'CLOSED_NOW' ? CLOSED_TTL_MS : STATUS_TTL_MS;

/** Who is reporting: a signed-in user, or a signed-out device (sgw_anon cookie). */
export type Reporter = { userId: string; deviceId?: undefined } | { userId?: undefined; deviceId: string };

/** New expiry after a confirmation: +1h, capped at createdAt+6h, never shortened. */
export function extendedExpiry(r: Pick<StatusReport, 'createdAt' | 'expiresAt'>): Date {
  const cap = Math.max(r.expiresAt.getTime(), r.createdAt.getTime() + CONFIRM_CAP_MS);
  return new Date(Math.min(r.expiresAt.getTime() + CONFIRM_EXTEND_MS, cap));
}

@Injectable()
export class StatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly points: PointsService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** `others` = the toilet's unexpired reports, to decide whether an anonymous closure is confirmed. */
  private view(r: StatusReport, confirmedByMe: boolean, others: StatusReport[]): StatusReportView {
    return {
      id: r.id,
      kind: r.kind,
      confirmations: r.confirmations,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      confirmedByMe,
      unconfirmed: isUnconfirmed(r, others),
    };
  }

  private unexpired(toiletId: string, now: Date) {
    return this.prisma.statusReport.findMany({ where: { toiletId, expiresAt: { gt: now } } });
  }

  private async assertToilet(toiletId: string) {
    const t = await this.prisma.toilet.findUnique({ where: { id: toiletId }, select: { status: true, tier: true } });
    if (!t || t.status === 'REJECTED') throw new NotFoundException('Toilet not found');
    return t;
  }

  async active(toiletId: string, userId: string | null, now = new Date()) {
    await this.assertToilet(toiletId);
    const rows = await this.prisma.statusReport.findMany({
      where: { toiletId, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      include: userId ? { confirmedBy: { where: { userId }, select: { userId: true } } } : undefined,
    });
    return {
      items: rows.map((r) =>
        this.view(r, 'confirmedBy' in r && Array.isArray(r.confirmedBy) && r.confirmedBy.length > 0, rows),
      ),
    };
  }

  /**
   * Same reporter (user or device) + toilet + kind within 30 min returns the existing report.
   * `analytics` says where it came from (web by default; the Telegram bot passes its own).
   */
  async report(toiletId: string, who: Reporter, kind: StatusKind, now = new Date(), analytics: AnalyticsContext = WEB) {
    const toilet = await this.assertToilet(toiletId);
    const reporter = who.userId !== undefined ? { userId: who.userId } : { deviceId: who.deviceId, userId: null };
    const existing = await this.prisma.statusReport.findFirst({
      where: { toiletId, ...reporter, kind, createdAt: { gte: new Date(now.getTime() - DEDUPE_WINDOW_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return this.view(existing, false, await this.unexpired(toiletId, now));
    const anonymous = who.userId === undefined;
    const r = await this.prisma.statusReport.create({
      data: {
        toiletId,
        ...reporter,
        kind,
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttlFor(kind, anonymous)),
      },
    });
    this.analytics.track('status_report', distinctIdFor(who, analytics), {
      after_route: false,
      ...baseProps(who, analytics),
      toilet_id: toiletId,
      toilet_tier: toilet.tier,
      kind,
    });
    return this.view(r, false, await this.unexpired(toiletId, now));
  }

  /** One confirmation per user; not your own; extends expiry; awards the reporter. */
  async confirm(reportId: string, userId: string, now = new Date()) {
    const r = await this.prisma.statusReport.findUnique({ where: { id: reportId } });
    if (!r || r.expiresAt <= now) throw new NotFoundException('Status report not found or expired');
    if (r.userId === userId) throw new BadRequestException("You can't confirm your own report");

    const updated = await this.prisma.$transaction(async (tx) => {
      const created = await tx.statusConfirmation.createMany({
        data: [{ statusReportId: r.id, userId }],
        skipDuplicates: true,
      });
      if (created.count === 0) return null; // already confirmed: idempotent
      const fresh = await tx.statusReport.findUniqueOrThrow({ where: { id: r.id } });
      const u = await tx.statusReport.update({
        where: { id: r.id },
        data: { confirmations: { increment: 1 }, expiresAt: extendedExpiry(fresh) },
      });
      // Anonymous reporters earn nothing here (their reports are merged on sign-in, confirmations aren't).
      if (r.userId) {
        const paidToday = await tx.pointsLedger.count({
          where: {
            userId: r.userId,
            reason: 'STATUS_CONFIRMED',
            refId: { endsWith: `:${userId}` },
            createdAt: { gte: sgtDayStart(now) },
          },
        });
        if (paidToday < CONFIRM_POINTS_PER_PAIR_PER_DAY) {
          await this.points.award(r.userId, 'STATUS_CONFIRMED', `${r.id}:${userId}`, { tx });
        }
      }
      return u;
    });
    const others = await this.unexpired(r.toiletId, now);
    if (updated) return this.view(updated, true, others);
    const current = await this.prisma.statusReport.findUniqueOrThrow({ where: { id: r.id } });
    return this.view(current, true, others);
  }
}
