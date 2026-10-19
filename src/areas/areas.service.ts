import { Injectable, NotFoundException } from '@nestjs/common';
import type { ToiletTier } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { bboxAround, haversineM } from '../common/geo.js';
import { ToiletPresenter, summaryInclude } from '../toilets/toilet-presenter.service.js';
import type { ToiletSummary } from '../toilets/toilet.schemas.js';
import type { AreaDetail, AreaSummary, AreaVenue } from './areas.dto.js';
import { areaSlug, regionOf } from './regions.js';

/** Below this many ACTIVE toilets an area page renders but is kept out of search engines. */
export const MIN_INDEXABLE_TOILETS = 3;
/** A "near X" hint further than this stops helping anyone find the place. */
const NEAR_MAX_M = 1500;

const TIER_RANK: Record<ToiletTier, number> = { VERIFIED: 0, COMMUNITY: 1, IMPORTED: 2 };

/** Open before closed, verified before imported, cleaner first, unscored last. */
export function compareToilets(a: ToiletSummary, b: ToiletSummary): number {
  return (
    Number(a.status !== 'ACTIVE') - Number(b.status !== 'ACTIVE') ||
    TIER_RANK[a.tier] - TIER_RANK[b.tier] ||
    (b.scoreCleanliness ?? -1) - (a.scoreCleanliness ?? -1) ||
    (a.label ?? '').localeCompare(b.label ?? '')
  );
}

@Injectable()
export class AreasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presenter: ToiletPresenter,
  ) {}

  /** Every planning area with at least one ACTIVE toilet, A to Z. */
  async list(): Promise<AreaSummary[]> {
    const rows = await this.prisma.toilet.findMany({
      where: { status: 'ACTIVE', venue: { toiletStatus: { not: 'NONE' }, planningArea: { not: null } } },
      select: { tier: true, venueId: true, venue: { select: { planningArea: true } } },
    });
    const bySlug = new Map<string, { name: string; toilets: number; verified: number; venues: Set<string> }>();
    for (const t of rows) {
      const name = t.venue.planningArea!;
      const slug = areaSlug(name);
      let a = bySlug.get(slug);
      if (!a) bySlug.set(slug, (a = { name, toilets: 0, verified: 0, venues: new Set() }));
      a.toilets++;
      if (t.tier === 'VERIFIED') a.verified++;
      a.venues.add(t.venueId);
    }
    return [...bySlug.entries()]
      .map(([slug, a]) => this.summary(slug, a.name, a.toilets, a.verified, a.venues.size))
      .sort((x, y) => x.name.localeCompare(y.name));
  }

  async detail(slug: string, now = new Date()): Promise<AreaDetail> {
    const name = await this.resolve(slug);
    if (!name) throw new NotFoundException('Area not found');
    const inArea = { planningArea: { equals: name, mode: 'insensitive' as const } };

    const [toilets, venues] = await Promise.all([
      this.prisma.toilet.findMany({
        where: {
          status: { in: ['ACTIVE', 'CLOSED', 'RENOVATION', 'PENDING'] },
          venue: { ...inArea, toiletStatus: { not: 'NONE' } },
        },
        include: summaryInclude(now),
      }),
      this.prisma.venue.findMany({ where: inArea }),
    ]);

    const pendingCount = toilets.filter((t) => t.status === 'PENDING').length;
    const byVenue = new Map<string, AreaVenue>();
    for (const t of toilets) {
      if (t.status === 'PENDING') continue;
      let v = byVenue.get(t.venueId);
      if (!v) {
        v = { ...this.presenter.venueLite(t.venue), address: t.venue.address, near: null, toilets: [] };
        byVenue.set(t.venueId, v);
      }
      v.toilets.push(this.presenter.toSummary(t, now));
    }

    const listed = [...byVenue.values()];
    const landmarks = await this.landmarksAround(listed.filter((v) => !v.address));
    for (const v of listed) {
      v.toilets.sort(compareToilets);
      if (v.address) continue;
      let best: { name: string; type: AreaVenue['type']; distanceM: number } | null = null;
      for (const l of landmarks) {
        if (l.id === v.id) continue;
        const d = haversineM(v, { lat: l.latitude, lng: l.longitude });
        if (d <= NEAR_MAX_M && (!best || d < best.distanceM)) best = { name: l.name, type: l.type, distanceM: d };
      }
      v.near = best ? { ...best, distanceM: Math.round(best.distanceM) } : null;
    }
    // A place ranks by its best toilet, so a mall with one great toilet beats one with three unscored ones.
    listed.sort((a, b) => compareToilets(a.toilets[0], b.toilets[0]) || a.name.localeCompare(b.name));

    const active = listed.flatMap((v) => v.toilets.filter((t) => t.status === 'ACTIVE'));
    const summary = this.summary(
      areaSlug(name),
      name,
      active.length,
      active.filter((t) => t.tier === 'VERIFIED').length,
      listed.filter((v) => v.toilets.some((t) => t.status === 'ACTIVE')).length,
    );

    return {
      ...summary,
      pendingCount,
      center: this.center(name, listed),
      venues: listed,
      noToiletVenues: venues
        .filter((v) => v.toiletStatus === 'NONE' || v.toiletStatus === 'USES_NEARBY')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((v) => this.presenter.venueLite(v)),
    };
  }

  /** Named places (not OTHER) within reach of the given ones, across area borders: the nearest MRT may be next door. */
  private async landmarksAround(places: { lat: number; lng: number }[]) {
    if (!places.length) return [];
    const box = places.reduce(
      (b, p) => {
        const r = bboxAround(p, NEAR_MAX_M);
        return {
          minLat: Math.min(b.minLat, r.minLat),
          maxLat: Math.max(b.maxLat, r.maxLat),
          minLng: Math.min(b.minLng, r.minLng),
          maxLng: Math.max(b.maxLng, r.maxLng),
        };
      },
      { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity },
    );
    return this.prisma.venue.findMany({
      where: {
        type: { not: 'OTHER' },
        latitude: { gte: box.minLat, lte: box.maxLat },
        longitude: { gte: box.minLng, lte: box.maxLng },
      },
      select: { id: true, name: true, type: true, latitude: true, longitude: true },
    });
  }

  /** The stored spelling of the area a slug points at, or null. */
  private async resolve(slug: string): Promise<string | null> {
    const rows = await this.prisma.venue.findMany({
      where: { planningArea: { not: null } },
      select: { planningArea: true },
      distinct: ['planningArea'],
    });
    return rows.map((r) => r.planningArea!).find((a) => areaSlug(a) === slug) ?? null;
  }

  private summary(slug: string, name: string, toilets: number, verified: number, venues: number): AreaSummary {
    return {
      slug,
      name,
      region: regionOf(name),
      toiletCount: toilets,
      verifiedCount: verified,
      venueCount: venues,
      indexable: toilets >= MIN_INDEXABLE_TOILETS,
    };
  }

  /** The area's namesake MRT station (Tampines -> Tampines MRT), else the listed place nearest the middle. */
  private center(name: string, venues: AreaVenue[]): AreaDetail['center'] {
    const namesake = venues.find((v) => v.type === 'MRT_STATION' && v.name.toLowerCase() === name.toLowerCase());
    if (namesake) return { lat: namesake.lat, lng: namesake.lng };
    if (!venues.length) return null;
    const mid = {
      lat: venues.reduce((s, v) => s + v.lat, 0) / venues.length,
      lng: venues.reduce((s, v) => s + v.lng, 0) / venues.length,
    };
    const nearest = venues.reduce((best, v) => (haversineM(mid, v) < haversineM(mid, best) ? v : best));
    return { lat: nearest.lat, lng: nearest.lng };
  }
}
