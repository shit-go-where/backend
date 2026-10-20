import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PointsService, POINTS } from './points.service.js';
import type { Prisma, PrismaClient, User } from '../generated/prisma/client.js';
import { Feature, PointReason, ToiletStatus, VenueToiletStatus, VenueType } from '../generated/prisma/enums.js';
import { haversineM } from '../common/geo.js';
import { BADGES, FOUNDING_BADGE_ID, MRT_LINES, earnedBadgeIds, type MrtLine } from './badges.js';
import { rankWithTies } from './ranking.js';
import { sgtDayStart } from './sgt.js';
import { advisoryLock } from '../common/locks.js';
import { onVercel, syncBadges } from './badge-sync.js';
import type { BadgeView, CheckInResult, Leaderboard } from './gamification.schemas.js';
import { confirmByCheckIn, escalateIfFlagged } from '../submissions/resolution.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { WEB, baseProps, distinctIdFor, roundDistance, type AnalyticsContext } from '../analytics/analytics.js';

type Db = PrismaClient | Prisma.TransactionClient;

export const CHECK_IN_RADIUS_M = 150;
export const CHECK_IN_COOLDOWN_MS = 2 * 3_600_000;
export const CHECK_IN_DAILY_POINT_CAP = 5;
/** Signed-out check-ins per device per Singapore day (and the same 2 h cooldown per toilet). */
export const ANON_CHECK_INS_PER_DAY = 5;
const DAY_MS = 86_400_000;
const LEADERBOARD_TTL_MS = 5 * 60_000;
const WEEK_MS = 7 * 86_400_000;

/** Most decision-relevant features, in prompt order (PLAN.md §6.5). */
export const VERIFY_PRIORITY: Feature[] = [
  Feature.BIDET,
  Feature.ACCESSIBLE,
  Feature.TOILET_PAPER,
  // Hawker centre and coffee shop toilets often charge 10-20 cents, and "Free" is a filter.
  Feature.FREE,
  Feature.HAND_SOAP,
  Feature.SITTING,
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
  private readonly log = new Logger(GamificationService.name);
  private readonly lbCache = new Map<LeaderboardScope, { at: number; items: Leaderboard['items'] }>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PointsService) private readonly points: PointsService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
  ) {}

  /**
   * Badge rows must exist before any UserBadge insert (see badge-sync.ts). On Vercel the build syncs
   * them (`pnpm vercel-build`), so a cold start runs no query at all: an uptime probe on /health/live
   * must not wake Neon. Locally, in CI and e2e it syncs here. A database outage must not stop the API
   * from booting, so a failure is only logged.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (onVercel()) return;
    try {
      await syncBadges(this.prisma);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      const reason = typeof code === 'string' ? code : err instanceof Error ? err.name : 'unknown error';
      this.log.warn(`Badge sync skipped, database unavailable (${reason}); retried on the next start`);
    }
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
    // Founding slots only matter until this user holds the badge.
    const foundingHolders = existing.some((e) => e.badgeId === FOUNDING_BADGE_ID)
      ? 0
      : await db.userBadge.count({ where: { badgeId: FOUNDING_BADGE_ID } });
    const lineStations: Partial<Record<MrtLine, string[]>> = {};
    for (const line of MRT_LINES) lineStations[line] = stations.filter((s) => s.lines.includes(line)).map((s) => s.id);

    const earned = earnedBadgeIds({
      checkIns: checkIns.map((c) => ({ createdAt: c.createdAt, toiletId: c.toiletId, venueId: c.toilet.venueId })),
      lineStations,
      approvedSubmissions,
      reviews,
      approvedPhotos,
      role: user.role,
      foundingHolders,
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
      select: { id: true, status: true, tier: true, latitude: true, longitude: true, createdById: true },
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

  private async verifyPrompt(toiletId: string): Promise<Feature[]> {
    const features = await this.prisma.toiletFeature.findMany({
      where: { toiletId, feature: { in: VERIFY_PRIORITY } },
      select: { feature: true },
    });
    return pickVerifyPrompt(features.map((f) => f.feature));
  }

  /**
   * Signed-in check-in. At a PENDING toilet someone else added (or an auto-published one awaiting
   * its second person), it also counts as an APPROVE vote (submissions/resolution.ts confirmByCheckIn).
   */
  async checkIn(
    user: User,
    toiletId: string,
    lat: number,
    lng: number,
    analytics: AnalyticsContext = WEB,
  ): Promise<CheckInResult> {
    // Coordinates are used for verification only and never stored (PLAN.md §11 B8).
    const { toilet, distanceM } = await this.loadToiletWithin(toiletId, lat, lng);
    if (toilet.status !== ToiletStatus.ACTIVE && toilet.status !== ToiletStatus.PENDING) {
      throw new BadRequestException('This toilet is not active');
    }

    const now = new Date();
    const { id, pointsAwarded, confirmation } = await this.prisma.$transaction(async (tx) => {
      // One check-in at a time per person: parallel requests used to pass the cooldown and the
      // daily point cap together (read committed) and each earn points.
      await advisoryLock(tx, `check-in:user:${user.id}`);
      const recent = await tx.checkIn.findFirst({
        where: { userId: user.id, toiletId, createdAt: { gt: new Date(now.getTime() - CHECK_IN_COOLDOWN_MS) } },
        select: { id: true },
      });
      if (recent) {
        throw new HttpException('You already checked in here in the last 2 hours', HttpStatus.TOO_MANY_REQUESTS);
      }
      const before = await tx.checkIn.count({ where: { userId: user.id, toiletId } });
      const checkIn = await tx.checkIn.create({ data: { userId: user.id, toiletId, distanceM } });
      // Seen by: each person's first check-in here (the submitter is already counted).
      if (before === 0 && toilet.createdById !== user.id) {
        await tx.toilet.update({ where: { id: toiletId }, data: { seenBy: { increment: 1 } } });
      }
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
      const confirmation = await confirmByCheckIn(tx, this.points, {
        toiletId,
        userId: user.id,
        distanceM,
        checkInId: checkIn.id,
      });
      return { id: checkIn.id, pointsAwarded: pts, confirmation };
    });

    for (const other of confirmation.evaluate.filter((u) => u !== user.id)) {
      try {
        await this.evaluateBadges(other);
      } catch (err) {
        this.log.warn(`badge evaluation failed for ${other}: ${String(err)}`);
      }
    }
    const [newBadges, verifyPrompt] = await Promise.all([this.evaluateBadges(user.id), this.verifyPrompt(toiletId)]);
    this.analytics.track('checkin', distinctIdFor({ userId: user.id }, analytics), {
      ...baseProps({ userId: user.id }, analytics),
      toilet_id: toiletId,
      toilet_tier: toilet.tier,
      distance_m: roundDistance(distanceM),
      on_pending: toilet.status === ToiletStatus.PENDING,
    });
    return {
      id,
      distanceM,
      pointsAwarded,
      newBadges,
      verifyPrompt,
      confirmedPending: confirmation.confirmedPending,
      wentLive: confirmation.wentLive,
      bankedPoints: 0,
    };
  }

  /**
   * Signed-out check-in (PLAN.md §12 E4), identified by the sgw_anon device id. Same 150 m rule and
   * 2 h cooldown; at most 5 per device per Singapore day. Never votes and never counts toward Seen by.
   * Earns nothing now: `bankedPoints` is what the device would have earned, paid on sign-in (mergeDevice).
   */
  async anonymousCheckIn(
    deviceId: string,
    toiletId: string,
    lat: number,
    lng: number,
    analytics: AnalyticsContext = WEB,
  ): Promise<CheckInResult> {
    const { toilet, distanceM } = await this.loadToiletWithin(toiletId, lat, lng);
    if (toilet.status === ToiletStatus.PENDING) {
      throw new UnauthorizedException('Sign in to confirm a new toilet');
    }
    if (toilet.status !== ToiletStatus.ACTIVE) throw new BadRequestException('This toilet is not active');
    const now = new Date();
    const { checkIn, here } = await this.prisma.$transaction(async (tx) => {
      // Same serialisation as signed-in check-ins, so parallel requests cannot beat the device caps.
      await advisoryLock(tx, `check-in:device:${deviceId}`);
      const [recent, today, here] = await Promise.all([
        tx.checkIn.count({
          where: { deviceId, toiletId, createdAt: { gt: new Date(now.getTime() - CHECK_IN_COOLDOWN_MS) } },
        }),
        tx.checkIn.count({ where: { deviceId, userId: null, createdAt: { gte: sgtDayStart(now) } } }),
        tx.checkIn.count({ where: { deviceId, userId: null, toiletId } }),
      ]);
      if (recent > 0) {
        throw new HttpException('You already checked in here in the last 2 hours', HttpStatus.TOO_MANY_REQUESTS);
      }
      if (today >= ANON_CHECK_INS_PER_DAY) {
        throw new HttpException(
          `You can check in ${ANON_CHECK_INS_PER_DAY} times a day without signing in. Sign in to keep going.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return { checkIn: await tx.checkIn.create({ data: { deviceId, toiletId, distanceM } }), here };
    });
    // The daily cap on CHECK_IN points (5) is never hit here: the device itself is capped at 5 a day.
    const bankedPoints = POINTS.CHECK_IN + (here === 0 ? POINTS.FIRST_CHECK_IN_AT_TOILET : 0);
    this.analytics.track('checkin', distinctIdFor({ deviceId }, analytics), {
      ...baseProps({}, analytics),
      toilet_id: toiletId,
      toilet_tier: toilet.tier,
      distance_m: roundDistance(distanceM),
      on_pending: false,
    });
    return {
      id: checkIn.id,
      distanceM,
      pointsAwarded: 0,
      newBadges: [],
      verifyPrompt: await this.verifyPrompt(toiletId),
      confirmedPending: false,
      wentLive: false,
      bankedPoints,
    };
  }

  /**
   * On sign-in: move this device's anonymous check-ins and status reports to the user and pay the
   * banked check-in points, applying the 5-a-day CHECK_IN cap per original Singapore day.
   * Idempotent: rows already moved are not found again, and ledger rows are unique per refId.
   */
  async mergeDevice(userId: string, deviceId: string) {
    const merged = await this.prisma.$transaction(async (tx) => {
      const checkIns = await tx.checkIn.findMany({
        where: { deviceId, userId: null },
        select: { id: true, toiletId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      if (checkIns.length > 0) {
        await tx.checkIn.updateMany({
          where: { id: { in: checkIns.map((c) => c.id) } },
          data: { userId, deviceId: null },
        });
      }
      let points = 0;
      for (const c of checkIns) {
        const dayStart = sgtDayStart(c.createdAt);
        const thatDay = await tx.pointsLedger.count({
          where: {
            userId,
            reason: PointReason.CHECK_IN,
            createdAt: { gte: dayStart, lt: new Date(dayStart.getTime() + DAY_MS) },
          },
        });
        const opts = { tx, createdAt: c.createdAt };
        if (thatDay < CHECK_IN_DAILY_POINT_CAP && (await this.points.award(userId, 'CHECK_IN', c.id, opts))) {
          points += POINTS.CHECK_IN;
        }
        if (await this.points.award(userId, 'FIRST_CHECK_IN_AT_TOILET', c.toiletId, opts)) {
          points += POINTS.FIRST_CHECK_IN_AT_TOILET;
        }
      }
      const reports = await tx.statusReport.updateMany({
        where: { deviceId, userId: null },
        data: { userId, deviceId: null },
      });
      return { checkIns: checkIns.length, statusReports: reports.count, points };
    });
    if (merged.checkIns > 0) await this.evaluateBadges(userId);
    return merged;
  }

  async verify(user: User, toiletId: string, body: { lat: number; lng: number; accurate: boolean; note?: string }) {
    const { toilet } = await this.loadToiletWithin(toiletId, body.lat, body.lng);
    if (toilet.status === ToiletStatus.PENDING || toilet.status === ToiletStatus.REJECTED) {
      throw new BadRequestException('This toilet is not verified yet');
    }
    if (body.accurate) {
      await this.prisma.toilet.update({
        where: { id: toiletId },
        data: { lastVerifiedAt: new Date(), lastVerifiedById: user.id },
      });
    } else {
      const reason = 'Check-in: listing inaccurate' + (body.note ? ` - ${body.note}` : '');
      await this.prisma.flag.create({ data: { toiletId, userId: user.id, reason } });
      await escalateIfFlagged(this.prisma, toiletId);
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
      select: { id: true, handle: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    const items = rankWithTies(
      groups.flatMap((g) => {
        const u = byId.get(g.userId);
        // avatarUrl is always null: profile pictures are not public (the field stays for the contract).
        return u?.handle ? [{ handle: u.handle, avatarUrl: null, points: g._sum.delta ?? 0 }] : [];
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
