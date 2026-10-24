import { Injectable } from '@nestjs/common';
import type { AreaType, Feature } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { bboxAround, estimateWalkSeconds, haversineM, type LatLng } from '../common/geo.js';
import { ToiletPresenter } from '../toilets/toilet-presenter.service.js';
import type { SexPreference } from '../toilets/sex.js';
import type { ToiletSummary } from '../toilets/toilet.schemas.js';
import { OneMapService } from './onemap.service.js';
import { countedReports } from '../status/unconfirmed.js';
import { rankUnconfirmedLower, unconfirmedReasons } from './unconfirmed.js';
import { PURPOSE_NEEDS, type Purpose } from './purposes.js';
import { floorReason, floorSeconds, userLevelOrder } from './levels.js';
import {
  byWalkMinutes,
  rank,
  reasons,
  resolveWeights,
  walkingMetres,
  type RankCandidate,
  type Ranked,
} from './ranking.js';

export const URGENT_RADII = [800, 1500, 3000];
export const DEFAULT_RADIUS = 1500;
export const MAX_RADIUS = 5000;
const TOP_N = 3;
const MAX_SKIPPED = 10;

export interface RecommendInput {
  lat: number;
  lng: number;
  urgent?: boolean;
  purpose?: Purpose;
  require?: Feature[];
  areaType?: AreaType;
  /** Only toilets usable by this sex. */
  sex?: SexPreference;
  openNow?: boolean;
  radiusM?: number;
  weights?: { distance?: number; cleanliness?: number; freshness?: number };
  /** The floor they're on ("B1", "level 3"); unknown prefers toilets near the ground. */
  level?: string;
}

export interface RecommendItem {
  toilet: ToiletSummary;
  score: number;
  walkSeconds: number;
  walkDistanceM: number;
  reasons: string[];
  route: { polyline: [number, number][]; source: 'onemap' | 'estimate' } | null;
  /** A pending community toilet nobody has confirmed yet (calm mode only). */
  unconfirmed: boolean;
}

/** The floor reason goes right after the walk minutes: "4 min walk", "1 floor up", ... */
function withFloor(why: string[], floor: string | null): string[] {
  return floor ? [why[0]!, floor, ...why.slice(1)] : why;
}

@Injectable()
export class RecommendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presenter: ToiletPresenter,
    private readonly onemap: OneMapService,
  ) {}

  async recommend(input: RecommendInput, now = new Date()) {
    const origin: LatLng = { lat: input.lat, lng: input.lng };
    const urgent = input.urgent ?? false;
    const radii = urgent
      ? URGENT_RADII
      : [Math.min(input.radiusM ?? DEFAULT_RADIUS, MAX_RADIUS)];
    const maxRadius = radii[radii.length - 1];
    const required = input.require ?? [];

    // One query at the widest radius; widen in memory.
    const rows = await this.presenter.findSummaries(
      ToiletPresenter.where({
        features: required,
        areaType: input.areaType,
        sex: input.sex,
        bbox: bboxAround(origin, maxRadius),
        // Calm results may offer unconfirmed (PENDING) toilets, labelled; urgent mode never does.
        includePending: !urgent,
      }),
      now,
    );
    const pool = rows
      .map((row) => {
        const summary = this.presenter.toSummary(row, now, origin);
        const order = ToiletPresenter.levelOrderOf(row);
        const candidate: RankCandidate & { summary: ToiletSummary; levelOrder: number | null } = {
          id: row.id,
          distanceM: haversineM(origin, { lat: row.latitude, lng: row.longitude }),
          scoreCleanliness: row.scoreCleanliness,
          tier: row.tier,
          source: row.source,
          lastVerifiedAt: row.lastVerifiedAt,
          features: summary.features,
          // Unconfirmed anonymous closures never take a toilet out of routing.
          reports: countedReports(row.statusReports),
          floorSeconds: floorSeconds(input.level, order),
          levelOrder: order,
          summary,
        };
        return candidate;
      })
      // Never route anyone to a toilet that is definitely closed right now (e.g. an MRT station
      // after 00:30), whether or not openNow was requested. Unknown hours (null) stay eligible,
      // since most imported toilets have no hours; `openNow` is kept for API compatibility.
      .filter((c) => c.summary.openNow !== false);

    const weights = resolveWeights(urgent, input.weights);
    const needs = input.purpose ? PURPOSE_NEEDS[input.purpose] : undefined;
    const preferred = Object.keys(needs?.prefer ?? {}) as Feature[];
    let searchedRadiusM = radii[0];
    let ranked: Ranked<(typeof pool)[number]>[] = [];
    for (const r of radii) {
      searchedRadiusM = r;
      ranked = rank(
        pool.filter((c) => c.distanceM <= r),
        r,
        weights,
        now,
        needs,
      );
      if (ranked.length > 0) break;
    }
    if (!urgent) ranked = rankUnconfirmedLower(ranked, (c) => c.summary.status === 'PENDING');

    const top = ranked.slice(0, TOP_N);
    const routes = await Promise.all(
      top.map(({ candidate: c }) => this.onemap.walk(origin, { lat: c.summary.lat, lng: c.summary.lng })),
    );
    // Knowing their floor, the lift ride is part of the trip, so it shows in the minutes. The
    // unknown-floor ground preference only steers the ranking.
    const knowsFloor = userLevelOrder(input.level) !== null;
    const items: RecommendItem[] = top.map(({ candidate: c, score }, i) => {
      const route = routes[i];
      const walkSeconds =
        (route?.durationS ?? estimateWalkSeconds(c.distanceM)) + (knowsFloor ? (c.floorSeconds ?? 0) : 0);
      const unconfirmed = c.summary.status === 'PENDING';
      const why = withFloor(reasons(c, walkSeconds, required, now, preferred), floorReason(input.level, c.levelOrder));
      return {
        toilet: c.summary,
        score,
        walkSeconds,
        walkDistanceM: route?.distanceM ?? walkingMetres(c.distanceM),
        reasons: unconfirmed ? unconfirmedReasons(why) : why,
        route: route ? { polyline: route.polyline, source: route.source } : null,
        unconfirmed,
      };
    });

    const preference = new Map(top.map(({ candidate: c }) => [c.id, knowsFloor ? 0 : (c.floorSeconds ?? 0)]));
    return {
      items: urgent ? byWalkMinutes(items, (it) => preference.get(it.toilet.id) ?? 0) : items,
      searchedRadiusM,
      skippedVenues: await this.skippedVenues(origin, searchedRadiusM),
    };
  }

  /** Venues in range that have no toilet of their own, so the UI can explain the gap. */
  private async skippedVenues(origin: LatLng, radius: number) {
    const b = bboxAround(origin, radius);
    const venues = await this.prisma.venue.findMany({
      where: {
        toiletStatus: { in: ['NONE', 'USES_NEARBY'] },
        latitude: { gte: b.minLat, lte: b.maxLat },
        longitude: { gte: b.minLng, lte: b.maxLng },
      },
      select: { name: true, toiletStatus: true, note: true, latitude: true, longitude: true },
    });
    return venues
      .map((v) => ({
        name: v.name,
        toiletStatus: v.toiletStatus,
        note: v.note,
        distanceM: Math.round(haversineM(origin, { lat: v.latitude, lng: v.longitude })),
      }))
      .filter((v) => v.distanceM <= radius)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, MAX_SKIPPED);
  }
}
