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

const HOUR = 3_600_000;
export const STATUS_TTL_MS = 2 * HOUR;
export const CLOSED_TTL_MS = 24 * HOUR;
export const DEDUPE_WINDOW_MS = 30 * 60_000;
export const CONFIRM_EXTEND_MS = HOUR;
export const CONFIRM_CAP_MS = 6 * HOUR;

export const ttlFor = (kind: StatusKind) => (kind === 'CLOSED_NOW' ? CLOSED_TTL_MS : STATUS_TTL_MS);

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
  ) {}

  private view(r: StatusReport, confirmedByMe: boolean): StatusReportView {
    return {
      id: r.id,
      kind: r.kind,
      confirmations: r.confirmations,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      confirmedByMe,
    };
  }

  private async assertToilet(toiletId: string) {
    const t = await this.prisma.toilet.findUnique({ where: { id: toiletId }, select: { status: true } });
    if (!t || t.status === 'REJECTED') throw new NotFoundException('Toilet not found');
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
        this.view(r, 'confirmedBy' in r && Array.isArray(r.confirmedBy) && r.confirmedBy.length > 0),
      ),
    };
  }

  /** Same user+toilet+kind within 30 min returns the existing report. */
  async report(toiletId: string, userId: string, kind: StatusKind, now = new Date()) {
    await this.assertToilet(toiletId);
    const existing = await this.prisma.statusReport.findFirst({
      where: { toiletId, userId, kind, createdAt: { gte: new Date(now.getTime() - DEDUPE_WINDOW_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return this.view(existing, false);
    const r = await this.prisma.statusReport.create({
      data: { toiletId, userId, kind, createdAt: now, expiresAt: new Date(now.getTime() + ttlFor(kind)) },
    });
    return this.view(r, false);
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
      await this.points.award(r.userId, 'STATUS_CONFIRMED', `${r.id}:${userId}`, { tx });
      return u;
    });
    if (updated) return this.view(updated, true);
    const current = await this.prisma.statusReport.findUniqueOrThrow({ where: { id: r.id } });
    return this.view(current, true);
  }
}
