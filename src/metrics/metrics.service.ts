import { Injectable } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { MetricsDaily } from '../generated/prisma/client.js';
import { ToiletStatus, ToiletTier } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { sgtDateColumn, sgtDayStart } from '../gamification/sgt.js';

const DAY_MS = 86_400_000;
/** A Verified or Community toilet counts as fresh when someone confirmed it within this window. */
export const FRESH_WINDOW_MS = 90 * DAY_MS;
export const WAC_WINDOW_DAYS = 7;

export const MetricsDaySchema = z
  .object({
    day: z.string().describe('Singapore calendar day, YYYY-MM-DD'),
    wac: z.number().int().describe('Distinct contributors (users + anonymous devices) in the 7 days ending `day`'),
    contributors: z.number().int(),
    checkIns: z.number().int(),
    statusReports: z.number().int(),
    reviews: z.number().int(),
    submissions: z.number().int(),
    votes: z.number().int(),
    freshPct: z.number().describe('% of active Verified + Community toilets verified within 90 days'),
    toiletsByTier: z.object({ VERIFIED: z.number().int(), COMMUNITY: z.number().int(), IMPORTED: z.number().int() }),
    pendingCount: z.number().int(),
  })
  .meta({ id: 'MetricsDay' });
export type MetricsDay = z.infer<typeof MetricsDaySchema>;

export const MetricsQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(366).default(30) });
export class MetricsQueryDto extends createZodDto(MetricsQuerySchema) {}
export class MetricsListDto extends createZodDto(z.object({ items: z.array(MetricsDaySchema) })) {}

/** Postgres DATE columns come back as UTC midnight of that calendar day. */
const dayKeyOf = (d: Date) => d.toISOString().slice(0, 10);

export function toView(r: MetricsDaily): MetricsDay {
  const t = (r.toiletsByTier ?? {}) as Partial<Record<ToiletTier, number>>;
  return {
    day: dayKeyOf(r.day),
    wac: r.wac,
    contributors: r.contributors,
    checkIns: r.checkIns,
    statusReports: r.statusReports,
    reviews: r.reviews,
    submissions: r.submissions,
    votes: r.votes,
    freshPct: r.freshPct,
    toiletsByTier: { VERIFIED: t.VERIFIED ?? 0, COMMUNITY: t.COMMUNITY ?? 0, IMPORTED: t.IMPORTED ?? 0 },
    pendingCount: r.pendingCount,
  };
}

/**
 * Nightly community health numbers (GROWTH.md 0.2): the north-star metrics without any analytics
 * vendor. Written by the `metrics` job, read by /admin and the Telegram weekly broadcast.
 */
@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Distinct people (user id, else anonymous device) who contributed in [from, to). */
  private async distinctContributors(from: Date, to: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(DISTINCT who) AS n FROM (
        SELECT COALESCE("userId", 'd:' || "deviceId") AS who FROM "CheckIn"
          WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        UNION ALL
        SELECT COALESCE("userId", 'd:' || "deviceId") FROM "StatusReport"
          WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        UNION ALL
        SELECT "userId" FROM "Review" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        UNION ALL
        SELECT "submittedById" FROM "Submission" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
        UNION ALL
        SELECT "userId" FROM "SubmissionVote" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
      ) x WHERE who IS NOT NULL`;
    return Number(rows[0]?.n ?? 0);
  }

  /** Computes and upserts the row for the Singapore day containing `day`. Idempotent. */
  async compute(day: Date): Promise<MetricsDay> {
    const start = sgtDayStart(day);
    const end = new Date(start.getTime() + DAY_MS);
    const window = { createdAt: { gte: start, lt: end } };
    const trusted = { status: ToiletStatus.ACTIVE, tier: { in: [ToiletTier.VERIFIED, ToiletTier.COMMUNITY] } };

    const [contributors, wac, checkIns, statusReports, reviews, submissions, votes, tiers, trustedTotal, fresh, pending] =
      await Promise.all([
        this.distinctContributors(start, end),
        this.distinctContributors(new Date(end.getTime() - WAC_WINDOW_DAYS * DAY_MS), end),
        this.prisma.checkIn.count({ where: window }),
        this.prisma.statusReport.count({ where: window }),
        this.prisma.review.count({ where: window }),
        this.prisma.submission.count({ where: window }),
        this.prisma.submissionVote.count({ where: window }),
        this.prisma.toilet.groupBy({ by: ['tier'], where: { status: ToiletStatus.ACTIVE }, _count: { _all: true } }),
        this.prisma.toilet.count({ where: trusted }),
        this.prisma.toilet.count({
          where: { ...trusted, lastVerifiedAt: { gte: new Date(end.getTime() - FRESH_WINDOW_MS), lt: end } },
        }),
        this.prisma.toilet.count({ where: { status: ToiletStatus.PENDING } }),
      ]);

    const toiletsByTier = { VERIFIED: 0, COMMUNITY: 0, IMPORTED: 0 };
    for (const g of tiers) toiletsByTier[g.tier] = g._count._all;
    const data = {
      wac,
      contributors,
      checkIns,
      statusReports,
      reviews,
      submissions,
      votes,
      freshPct: trustedTotal ? Math.round((fresh / trustedTotal) * 1000) / 10 : 0,
      toiletsByTier,
      pendingCount: pending,
    };
    const row = await this.prisma.metricsDaily.upsert({
      where: { day: sgtDateColumn(start) },
      create: { day: sgtDateColumn(start), ...data },
      update: data,
    });
    return toView(row);
  }

  /** The nightly job: the Singapore day that ended most recently, so a 03:00 SGT run sees a whole day. */
  async computeYesterday(now = new Date()): Promise<MetricsDay> {
    return this.compute(new Date(sgtDayStart(now).getTime() - DAY_MS));
  }

  async latest(): Promise<MetricsDay | null> {
    const r = await this.prisma.metricsDaily.findFirst({ orderBy: { day: 'desc' } });
    return r ? toView(r) : null;
  }

  /** Newest first, at most `days` rows. */
  async range(days: number): Promise<MetricsDay[]> {
    const rows = await this.prisma.metricsDaily.findMany({ orderBy: { day: 'desc' }, take: days });
    return rows.map(toView);
  }
}
