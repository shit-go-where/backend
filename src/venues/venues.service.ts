import { Injectable, NotFoundException } from '@nestjs/common';
import type { Venue } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { bboxAround, haversineM, type LatLng } from '../common/geo.js';
import { ToiletPresenter, summaryInclude } from '../toilets/toilet-presenter.service.js';

const SEARCH_LIMIT = 20;

@Injectable()
export class VenuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presenter: ToiletPresenter,
  ) {}

  /** Venues within radius, including NONE / USES_NEARBY ones, nearest first. */
  async nearby(origin: LatLng, radius: number) {
    const b = bboxAround(origin, radius);
    const rows = await this.prisma.venue.findMany({
      where: {
        latitude: { gte: b.minLat, lte: b.maxLat },
        longitude: { gte: b.minLng, lte: b.maxLng },
      },
      include: { _count: { select: { toilets: { where: { status: 'ACTIVE' } } } } },
    });
    return rows
      .map((v) => ({ v, d: haversineM(origin, { lat: v.latitude, lng: v.longitude }) }))
      .filter(({ d }) => d <= radius)
      .sort((a, b) => a.d - b.d)
      .map(({ v, d }) => ({
        ...this.presenter.venueLite(v),
        distanceM: Math.round(d),
        // Toilets at NONE venues are hidden everywhere else, so don't count them either.
        toiletCount: v.toiletStatus === 'NONE' ? 0 : v._count.toilets,
      }));
  }

  /** Name ILIKE search, max 20, nearest first when a location is given. */
  async search(q: string, origin?: LatLng) {
    const rows: Venue[] = await this.prisma.venue.findMany({
      where: { name: { contains: q, mode: 'insensitive' } },
      orderBy: { name: 'asc' },
      take: origin ? 200 : SEARCH_LIMIT,
    });
    const sorted = origin
      ? rows
          .map((v) => ({ v, d: haversineM(origin, { lat: v.latitude, lng: v.longitude }) }))
          .sort((a, b) => a.d - b.d)
          .map(({ v }) => v)
      : rows;
    return sorted.slice(0, SEARCH_LIMIT).map((v) => this.presenter.venueLite(v));
  }

  async detail(id: string, now = new Date()) {
    const v = await this.prisma.venue.findUnique({
      where: { id },
      include: {
        toilets: {
          where: { status: { not: 'REJECTED' } },
          include: summaryInclude(now),
          orderBy: [{ status: 'asc' }, { label: 'asc' }],
        },
      },
    });
    if (!v) throw new NotFoundException('Venue not found');
    return {
      ...this.presenter.venueLite(v),
      address: v.address,
      planningArea: v.planningArea,
      toilets: v.toilets.map((t) => this.presenter.toSummary({ ...t, venue: v }, now)),
    };
  }
}
