import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PointsService, POINTS } from './points.service.js';
import type { Prisma, PrismaClient, User } from '../generated/prisma/client.js';
import { Feature, PointReason, ToiletStatus, VenueToiletStatus, VenueType } from '../generated/prisma/enums.js';
import { haversineM } from '../common/geo.js';
import { BADGES, MRT_LINES, earnedBadgeIds, type MrtLine } from './badges.js';
import { rankWithTies } from './ranking.js';
import { sgtDayStart } from './sgt.js';
import type { BadgeView, Leaderboard } from './gamification.schemas.js';

type Db = PrismaClient | Prisma.TransactionClient;

export const CHECK_IN_RADIUS_M = 150;
export const CHECK_IN_COOLDOWN_MS = 2 * 3_600_000;
export const CHECK_IN_DAILY_POINT_CAP = 5;
const LEADERBOARD_TTL_MS = 5 * 60_000;
const WEEK_MS = 7 * 86_400_000;

/** Most decision-relevant features, in prompt order (PLAN.md §6.5). */
export const VERIFY_PRIORITY: Feature[] = [
  Feature.BIDET,
  Feature.ACCESSIBLE,
  Feature.TOILET_PAPER,
  Feature.HAND_SOAP,
  Feature.SITTING,
  Feature.SQUAT,
  Feature.BABY_CHANGE,
];

/** Up to 5 features to ask about: those the listing has a value for first, then unknown ones. Pure. */
export function pickVerifyPrompt(known: Feature[], max = 5): Feature[] {
  const k = new Set(known);
  return [...VERIFY_PRIORITY.filter((f) => k.has(f)), ...VERIFY_PRIORITY.filter((f) => !k.has(f))].slice(0, max);
}

type LeaderboardScope = 'week' | 'all';

@Injectable()
export class GamificationService implements OnApplicationBootstrap {
  private readonly lbCache = new Map<LeaderboardScope, { at: number; items: Leaderboard['items'] }>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PointsService) private readonly points: PointsService,
  ) {}

  /** Badge rows must exist before any UserBadge insert. Cheap idempotent upserts. */
  async onApplicationBootstrap(): Promise<void> {
    await this.prisma.$transaction(
      BADGES.map((b) =>
        this.prisma.badge.upsert({
          where: { id: b.id },
          create: { id: b.id, name: b.name, description: b.description, icon: b.icon, rule: b.rule },
          update: { name: b.name, description: b.description, icon: b.icon, rule: b.rule },
        }),
      ),
    );
  }

  /* ─────────────── badges ─────────────── */

  /** Evaluate every badge rule for a user, award new ones idempotently, return the newly awarded. */
  async evaluateBadges(userId: string, tx?: Prisma.TransactionClient): Promise<BadgeView[]> {
    const db: Db = tx ?? this.prisma;
    const [user, checkIns, stations, approvedSubmissions, reviews, approvedPhotos, existing] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { role: true } }),
      db.checkIn.findMany({
        where: { userId },
        select: { createdAt: true, toiletId: true, toilet: { select: { venueId: true } } },
      }),
      db.venue.findMany({
        where: { type: VenueType.MRT_STATION, toiletStatus: VenueToiletStatus.HAS_TOILETS },
        select: { id: true, lines: true },
      }),
      db.submission.count({ where: { submittedById: userId, state: 'APPROVED' } }),
      db.review.count({ where: { userId } }),
      db.photo.count({ where: { uploadedById: userId, approved: true } }),
      db.userBadge.findMany({ where: { userId }, select: { badgeId: true } }),
    ]);
    if (!user) return [];
    const lineStations: Partial<Record<MrtLine, string[]>> = {};
    for (const line of MRT_LINES) lineStations[line] = stations.filter((s) => s.lines.includes(line)).map((s) => s.id);

    const earned = earnedBadgeIds({
      checkIns: checkIns.map((c) => ({ createdAt: c.createdAt, toiletId: c.toiletId, venueId: c.toilet.venueId })),
      lineStations,
      approvedSubmissions,
      reviews,
      approvedPhotos,
      role: user.role,
    });
    const have = new Set(existing.map((e) => e.badgeId));
    const fresh = earned.filter((id) => !have.has(id));
    if (fresh.length === 0) return [];
    await db.userBadge.createMany({ data: fresh.map((badgeId) => ({ userId, badgeId })), skipDuplicates: true });
    const rows = await db.userBadge.findMany({
      where: { userId, badgeId: { in: fresh } },
      include: { badge: true },
    });
    return rows.map((r) => ({
      id: r.badge.id,
      name: r.badge.name,
      description: r.badge.description,
      icon: r.badge.icon,
      awardedAt: r.awardedAt.toISOString(),
    }));
  }

  async listBadges(user: User | null): Promise<{ items: BadgeView[] }> {
    const [badges, mine] = await Promise.all([
      this.prisma.badge.findMany(),
      user ? this.prisma.userBadge.findMany({ where: { userId: user.id } }) : Promise.resolve([]),
    ]);
    const order = new Map(BADGES.map((b, i) => [b.id, i]));
    const awarded = new Map(mine.map((m) => [m.badgeId, m.awardedAt]));
    return {
      items: badges
        .sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999))
        .map((b) => {
          const at = awarded.get(b.id);
          return {
            id: b.id,
            name: b.name,
            description: b.description,
            icon: b.icon,
            ...(at ? { awardedAt: at.toISOString() } : {}),
          };
        }),
    };
  }

  /* ─────────────── check-ins ─────────────── */

  private async loadToiletWithin(toiletId: string, lat: number, lng: number) {
    const toilet = await this.prisma.toilet.findUnique({
      where: { id: toiletId },
      select: { id: true, status: true, latitude: true, longitude: true },
    });
    if (!toilet) throw new NotFoundException('Toilet not found');
    const distanceM = Math.round(haversineM({ lat, lng }, { lat: toilet.latitude, lng: toilet.longitude }));
    if (distanceM > CHECK_IN_RADIUS_M) {
      throw new BadRequestException(
        `You are ${distanceM} m from this toilet; you need to be within ${CHECK_IN_RADIUS_M} m`,
      );
    }
    return { toilet, distanceM };
  }

  async checkIn(user: User, toiletId: string, lat: number, lng: number) {
    // Coordinates are used for verification only and never stored (PLAN.md §11 B8).
    const { toilet, distanceM } = await this.loadToiletWithin(toiletId, lat, lng);
    if (toilet.status !== ToiletStatus.ACTIVE) throw new BadRequestException('This toilet is not active');

    const now = new Date();
    const recent = await this.prisma.checkIn.findFirst({
      where: { userId: user.id, toiletId, createdAt: { gt: new Date(now.getTime() - CHECK_IN_COOLDOWN_MS) } },
      select: { id: true },
    });
    if (recent) {
      throw new HttpException('You already checked in here in the last 2 hours', HttpStatus.TOO_MANY_REQUESTS);
    }

    const { id, pointsAwarded } = await this.prisma.$transaction(async (tx) => {
      const checkIn = await tx.checkIn.create({ data: { userId: user.id, toiletId, distanceM } });
      let pts = 0;
      const today = await tx.pointsLedger.count({
        where: { userId: user.id, reason: PointReason.CHECK_IN, createdAt: { gte: sgtDayStart(now) } },
      });
      if (today < CHECK_IN_DAILY_POINT_CAP && (await this.points.award(user.id, 'CHECK_IN', checkIn.id, { tx }))) {
        pts += POINTS.CHECK_IN;
      }
      if (await this.points.award(user.id, 'FIRST_CHECK_IN_AT_TOILET', toiletId, { tx })) {
        pts += POINTS.FIRST_CHECK_IN_AT_TOILET;
      }
      return { id: checkIn.id, pointsAwarded: pts };
    });

    const [newBadges, features] = await Promise.all([
      this.evaluateBadges(user.id),
      this.prisma.toiletFeature.findMany({
        where: { toiletId, feature: { in: VERIFY_PRIORITY } },
        select: { feature: true },
      }),
    ]);
    return { id, distanceM, pointsAwarded, newBadges, verifyPrompt: pickVerifyPrompt(features.map((f) => f.feature)) };
  }

  async verify(user: User, toiletId: string, body: { lat: number; lng: number; accurate: boolean; note?: string }) {
    const { toilet } = await this.loadToiletWithin(toiletId, body.lat, body.lng);
    if (toilet.status === ToiletStatus.PENDING || toilet.status === ToiletStatus.REJECTED) {
      throw new BadRequestException('This toilet is not verified yet');
    }
    if (body.accurate) {
      await this.prisma.toilet.update({ where: { id: toiletId }, data: { lastVerifiedAt: new Date() } });
    } else {
      const reason = 'Check-in: listing inaccurate' + (body.note ? ` - ${body.note}` : '');
      await this.prisma.flag.create({ data: { toiletId, userId: user.id, reason } });
    }
    return { ok: true as const };
  }

  /* ─────────────── passport ─────────────── */

  async passport(user: User) {
    const [stations, checkIns] = await Promise.all([
      this.prisma.venue.findMany({
        where: { type: VenueType.MRT_STATION, toiletStatus: VenueToiletStatus.HAS_TOILETS },
        select: { id: true, name: true, lines: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.checkIn.findMany({
        where: { userId: user.id, toilet: { venue: { type: VenueType.MRT_STATION } } },
        select: { createdAt: true, toilet: { select: { venueId: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const firstAt = new Map<string, Date>();
    for (const c of checkIns) if (!firstAt.has(c.toilet.venueId)) firstAt.set(c.toilet.venueId, c.createdAt);
    const items = stations.map((s) => ({
      venueId: s.id,
      name: s.name,
      lines: s.lines,
      stampedAt: firstAt.get(s.id)?.toISOString() ?? null,
    }));
    return { stamped: items.filter((i) => i.stampedAt).length, total: items.length, stations: items };
  }

  /* ─────────────── leaderboard ─────────────── */

  clearLeaderboardCache(): void {
    this.lbCache.clear();
  }

  private ledgerWhere(scope: LeaderboardScope): Prisma.PointsLedgerWhereInput {
    return scope === 'week' ? { createdAt: { gte: new Date(Date.now() - WEEK_MS) } } : {};
  }

  private async topUsers(scope: LeaderboardScope): Promise<Leaderboard['items']> {
    const hit = this.lbCache.get(scope);
    if (hit && Date.now() - hit.at < LEADERBOARD_TTL_MS) return hit.items;
    const groups = await this.prisma.pointsLedger.groupBy({
      by: ['userId'],
      where: { ...this.ledgerWhere(scope), user: { leaderboardOptIn: true, handle: { not: null } } },
      _sum: { delta: true },
      having: { delta: { _sum: { gt: 0 } } },
      orderBy: [{ _sum: { delta: 'desc' } }, { userId: 'asc' }],
      take: 100,
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: groups.map((g) => g.userId) } },
      select: { id: true, handle: true, avatarUrl: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const items = rankWithTies(
      groups.flatMap((g) => {
        const u = byId.get(g.userId);
        return u?.handle ? [{ handle: u.handle, avatarUrl: u.avatarUrl, points: g._sum.delta ?? 0 }] : [];
      }),
    ).map(({ rank, handle, avatarUrl, points }) => ({ rank, handle, avatarUrl, points }));
    this.lbCache.set(scope, { at: Date.now(), items });
    return items;
  }

  async leaderboard(scope: LeaderboardScope, user: User | null): Promise<Leaderboard> {
    const items = await this.topUsers(scope);
    if (!user) return { items, me: null };
    const sum = await this.prisma.pointsLedger.aggregate({
      where: { ...this.ledgerWhere(scope), userId: user.id },
      _sum: { delta: true },
    });
    const points = sum._sum.delta ?? 0;
    if (!user.leaderboardOptIn || !user.handle) return { items, me: { rank: null, points } };
    const listed = items.find((i) => i.handle === user.handle);
    if (listed) return { items, me: { rank: listed.rank, points: listed.points } };
    const ahead = await this.prisma.pointsLedger.groupBy({
      by: ['userId'],
      where: { ...this.ledgerWhere(scope), user: { leaderboardOptIn: true, handle: { not: null } } },
      _sum: { delta: true },
      having: { delta: { _sum: { gt: points } } },
    });
    return { items, me: { rank: ahead.length + 1, points } };
  }
}
