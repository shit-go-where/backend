import { Injectable, NotFoundException } from '@nestjs/common';
import { ToiletStatus, ToiletTier, VenueToiletStatus, VenueType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { bboxAround, haversineM } from '../common/geo.js';
import { ToiletPresenter, summaryInclude } from '../toilets/toilet-presenter.service.js';
import { compareToilets } from '../areas/areas.service.js';
import { areaSlug } from '../areas/regions.js';
import { FRESH_WINDOW_MS } from '../metrics/metrics.service.js';
import { buildLineBoard, lineName, type LineRow } from './lines.js';
import type { StationDetail, StationSummary } from './stations.dto.js';
import { sexWhere, type SexPreference } from '../toilets/sex.js';

/** "Toilets near X MRT" means a short walk out of the station. */
export const NEARBY_RADIUS_M = 400;
const NEARBY_LIMIT = 5;
const WEEK_MS = 7 * 86_400_000;
const BOARD_TTL_MS = 5 * 60_000;

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

const stationWhere = { type: VenueType.MRT_STATION };
const stationSelect = {
  id: true,
  name: true,
  lines: true,
  latitude: true,
  longitude: true,
  toiletStatus: true,
  note: true,
  planningArea: true,
} as const;

type StationVenue = {
  id: string;
  name: string;
  lines: string[];
  latitude: number;
  longitude: number;
  toiletStatus: VenueToiletStatus;
};
type ToiletStat = {
  tier: ToiletTier;
  scoreCleanliness: number | null;
  lastVerifiedAt: Date | null;
};

/** Pure: a station's summary row from its venue and its ACTIVE toilets. */
export function summarize(v: StationVenue, toilets: ToiletStat[]): StationSummary {
  const scores = toilets.map((t) => t.scoreCleanliness).filter((s): s is number => s !== null);
  const verified = toilets.map((t) => t.lastVerifiedAt).filter((d): d is Date => d !== null);
  return {
    slug: areaSlug(v.name),
    name: v.name,
    lines: v.lines.map((code) => ({ code, name: lineName(code) })),
    lat: v.latitude,
    lng: v.longitude,
    toiletStatus: v.toiletStatus,
    toiletCount: toilets.length,
    verifiedCount: toilets.filter((t) => t.tier === ToiletTier.VERIFIED).length,
    bestScore: scores.length ? Math.max(...scores) : null,
    lastVerifiedAt: verified.length ? new Date(Math.max(...verified.map((d) => d.getTime()))).toISOString() : null,
    indexable: toilets.length > 0 || v.toiletStatus === VenueToiletStatus.NONE || v.toiletStatus === VenueToiletStatus.USES_NEARBY,
  };
}

/** MRT and LRT station pages (GROWTH.md 1.2) and the line board (GROWTH.md 1.11). */
@Injectable()
export class StationsService {
  private board: { at: number; items: LineRow[] } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenter: ToiletPresenter,
  ) {}

  private activeStationToilets() {
    return this.prisma.toilet.findMany({
      // A toilet at a station marked "no toilet" is bad data: never counted (as on area pages).
      where: { status: ToiletStatus.ACTIVE, venue: { ...stationWhere, toiletStatus: { not: VenueToiletStatus.NONE } } },
      select: { id: true, venueId: true, tier: true, scoreCleanliness: true, lastVerifiedAt: true },
    });
  }

  /**
   * Every station A to Z. `indexable` matches the detail page: a station with nothing of its own
   * on record is still worth a search result when an open toilet is a short walk away.
   */
  async list(): Promise<StationSummary[]> {
    const [venues, toilets, open] = await Promise.all([
      this.prisma.venue.findMany({ where: stationWhere, select: stationSelect, orderBy: { name: 'asc' } }),
      this.activeStationToilets(),
      this.prisma.toilet.findMany({
        where: { status: ToiletStatus.ACTIVE, venue: { toiletStatus: { not: VenueToiletStatus.NONE } } },
        select: { venueId: true, latitude: true, longitude: true },
      }),
    ]);
    const byVenue = groupBy(toilets, (t) => t.venueId);
    return venues.map((v) => {
      const s = summarize(v, byVenue.get(v.id) ?? []);
      if (s.indexable) return s;
      const origin = { lat: v.latitude, lng: v.longitude };
      const near = open.some(
        (t) => t.venueId !== v.id && haversineM(origin, { lat: t.latitude, lng: t.longitude }) <= NEARBY_RADIUS_M,
      );
      return near ? { ...s, indexable: true } : s;
    });
  }

  /** `sex` keeps only toilets usable by that sex, in the lists and the counts alike. */
  async detail(slug: string, sex?: SexPreference, now = new Date()): Promise<StationDetail> {
    const venues = await this.prisma.venue.findMany({ where: stationWhere, select: stationSelect });
    const v = venues.find((x) => areaSlug(x.name) === slug);
    if (!v) throw new NotFoundException('Station not found');

    const origin = { lat: v.latitude, lng: v.longitude };
    const box = bboxAround(origin, NEARBY_RADIUS_M);
    const usable = sex ? sexWhere(sex) : {};
    const [own, around] = await Promise.all([
      this.prisma.toilet.findMany({
        where: {
          venueId: v.id,
          venue: { toiletStatus: { not: VenueToiletStatus.NONE } },
          status: { in: [ToiletStatus.ACTIVE, ToiletStatus.CLOSED, ToiletStatus.RENOVATION] },
          ...usable,
        },
        include: summaryInclude(now),
      }),
      this.prisma.toilet.findMany({
        where: {
          status: ToiletStatus.ACTIVE,
          venueId: { not: v.id },
          venue: { toiletStatus: { not: VenueToiletStatus.NONE } },
          latitude: { gte: box.minLat, lte: box.maxLat },
          longitude: { gte: box.minLng, lte: box.maxLng },
          ...usable,
        },
        include: summaryInclude(now),
      }),
    ]);

    const toilets = own.map((t) => this.presenter.toSummary(t, now)).sort(compareToilets);
    const nearby = around
      .map((t) => this.presenter.toSummary(t, now, origin))
      .filter((t) => (t.distanceM ?? Infinity) <= NEARBY_RADIUS_M)
      .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0))
      .slice(0, NEARBY_LIMIT)
      .map((t) => ({ toilet: t, distanceM: Math.round(t.distanceM ?? 0) }));

    const summary = summarize(
      v,
      own.filter((t) => t.status === ToiletStatus.ACTIVE),
    );
    return {
      ...summary,
      indexable: summary.indexable || nearby.length > 0,
      note: v.note,
      area: v.planningArea ? { slug: areaSlug(v.planningArea), name: v.planningArea } : null,
      toilets,
      nearby,
    };
  }

  /** Line board, cached for 5 minutes like the user leaderboard. */
  async lineBoard(now = new Date()): Promise<LineRow[]> {
    if (this.board && now.getTime() - this.board.at < BOARD_TTL_MS) return this.board.items;
    const [venues, toilets, checkIns] = await Promise.all([
      this.prisma.venue.findMany({ where: stationWhere, select: { id: true, lines: true } }),
      this.activeStationToilets(),
      this.prisma.checkIn.groupBy({
        by: ['toiletId'],
        where: { createdAt: { gte: new Date(now.getTime() - WEEK_MS) }, toilet: { venue: stationWhere } },
        _count: { _all: true },
      }),
    ]);
    const freshSince = now.getTime() - FRESH_WINDOW_MS;
    const checkInsBy = new Map(checkIns.map((c) => [c.toiletId, c._count._all]));
    const byVenue = groupBy(toilets, (t) => t.venueId);
    const items = buildLineBoard(
      venues.map((v) => {
        const ts = byVenue.get(v.id) ?? [];
        const trusted = ts.filter((t) => t.tier !== ToiletTier.IMPORTED);
        const scores = ts.map((t) => t.scoreCleanliness).filter((s): s is number => s !== null);
        return {
          lines: v.lines,
          bestScore: scores.length ? Math.max(...scores) : null,
          trustedToilets: trusted.length,
          freshToilets: trusted.filter((t) => (t.lastVerifiedAt?.getTime() ?? 0) >= freshSince).length,
          checkInsWeek: ts.reduce((n, t) => n + (checkInsBy.get(t.id) ?? 0), 0),
          hasToilets: ts.length > 0,
        };
      }),
    );
    this.board = { at: now.getTime(), items };
    return items;
  }
}
