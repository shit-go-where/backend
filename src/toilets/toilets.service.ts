import { Injectable, NotFoundException } from '@nestjs/common';
import type { AreaType, Feature, ToiletTier } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { bboxAround, haversineM, type LatLng } from '../common/geo.js';
import { isOpenAt } from '../common/opening-hours.js';
import { ToiletPresenter } from './toilet-presenter.service.js';
import type { ToiletDetail, ToiletPin, ToiletSummary } from './toilet.schemas.js';

export interface NearbyOptions {
  radius: number;
  features?: Feature[];
  tier?: ToiletTier[];
  areaType?: AreaType;
  openNow?: boolean;
  includePending?: boolean;
  limit: number;
}

export const IN_BOUNDS_CAP = 3000;
export const LEADERBOARD_SIZE = 50;

@Injectable()
export class ToiletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presenter: ToiletPresenter,
  ) {}

  /** bbox prefilter in SQL, exact haversine + sort in JS. */
  async nearby(origin: LatLng, o: NearbyOptions, now = new Date()): Promise<ToiletSummary[]> {
    const where = ToiletPresenter.where({
      features: o.features,
      tier: o.tier,
      areaType: o.areaType,
      includePending: o.includePending,
      bbox: bboxAround(origin, o.radius),
    });
    const rows = await this.presenter.findSummaries(where, now);
    return rows
      .map((t) => ({ t, d: haversineM(origin, { lat: t.latitude, lng: t.longitude }) }))
      .filter(({ d }) => d <= o.radius)
      .sort((a, b) => a.d - b.d)
      .map(({ t }) => this.presenter.toSummary(t, now, origin))
      .filter((s) => !(o.openNow && s.openNow === false))
      .slice(0, o.limit);
  }

  async inBounds(
    bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
    o: {
      features?: Feature[];
      tier?: ToiletTier[];
      areaType?: AreaType;
      openNow?: boolean;
      includePending?: boolean;
    },
    now = new Date(),
  ): Promise<ToiletPin[]> {
    const rows = await this.prisma.toilet.findMany({
      where: ToiletPresenter.where({
        features: o.features,
        tier: o.tier,
        areaType: o.areaType,
        includePending: o.includePending,
        bbox: bounds,
      }),
      select: {
        id: true,
        venueId: true,
        latitude: true,
        longitude: true,
        level: true,
        levelOrder: true,
        tier: true,
        status: true,
        scoreCleanliness: true,
        openingHours: true,
        venue: { select: { type: true, openingHours: true } },
        statusReports: {
          where: { expiresAt: { gt: now } },
          select: { kind: true, createdAt: true, confirmations: true, userId: true, deviceId: true },
        },
      },
      take: IN_BOUNDS_CAP,
    });
    // Same rule as nearby: only toilets known to be closed drop out; unknown hours stay.
    return rows
      .filter((t) => !(o.openNow && isOpenAt(ToiletPresenter.effectiveHours(t), now) === false))
      .map((t) => this.presenter.toPin(t));
  }

  /** Toilets worth a search result: not pending or rejected, and not at a "no toilet" venue. */
  async sitemap() {
    const rows = await this.prisma.toilet.findMany({
      where: { status: { in: ['ACTIVE', 'CLOSED', 'RENOVATION'] }, venue: { toiletStatus: { not: 'NONE' } } },
      select: { id: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, updatedAt: r.updatedAt.toISOString() }));
  }

  async detail(id: string, userId: string | null): Promise<ToiletDetail> {
    const d = await this.presenter.detail(id, userId);
    if (!d) throw new NotFoundException('Toilet not found');
    return d;
  }

  /** Cleanest ACTIVE toilets, ties broken by latest survey total. Optionally per planning area. */
  async leaderboard(area: string | undefined, now = new Date()) {
    const areaWhere = area
      ? { planningArea: { equals: area, mode: 'insensitive' as const } }
      : {};
    const [scored, areaRows] = await Promise.all([
      this.prisma.toilet.findMany({
        where: { status: 'ACTIVE', scoreCleanliness: { not: null }, venue: areaWhere },
        select: {
          id: true,
          scoreCleanliness: true,
          surveys: { orderBy: { surveyedAt: 'desc' }, take: 1, select: { total: true } },
        },
      }),
      this.prisma.venue.findMany({
        where: { planningArea: { not: null }, toilets: { some: { status: 'ACTIVE' } } },
        select: { planningArea: true },
        distinct: ['planningArea'],
        orderBy: { planningArea: 'asc' },
      }),
    ]);
    const top = scored
      .map((t) => ({ id: t.id, score: t.scoreCleanliness ?? 0, total: t.surveys[0]?.total ?? -1 }))
      .sort((a, b) => b.score - a.score || b.total - a.total || a.id.localeCompare(b.id))
      .slice(0, LEADERBOARD_SIZE);
    const rows = await this.presenter.findSummaries({ id: { in: top.map((t) => t.id) } }, now);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = top.flatMap((t, i) => {
      const row = byId.get(t.id);
      return row ? [{ rank: i + 1, toilet: this.presenter.toSummary(row, now), score: t.score }] : [];
    });
    return {
      items,
      areas: areaRows.map((a) => a.planningArea).filter((a): a is string => a !== null),
    };
  }
}
