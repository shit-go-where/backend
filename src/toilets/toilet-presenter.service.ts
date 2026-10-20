import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { AreaType, Feature, ToiletTier } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { estimateWalkSeconds, haversineM, type LatLng } from '../common/geo.js';
import { isOpenAt, type OpeningHours } from '../common/opening-hours.js';
import { countedReports } from '../status/unconfirmed.js';
import type { Review, ToiletDetail, ToiletPin, ToiletSummary } from './toilet.schemas.js';
import { nearText } from './near.js';

/** Prisma include needed to build a ToiletSummary. Depends on `now` for unexpired status reports. */
export function summaryInclude(now: Date) {
  return {
    venue: true,
    features: { where: { present: true }, select: { feature: true } },
    surveys: {
      orderBy: { surveyedAt: 'desc' },
      take: 1,
      select: { total: true, rasStars: true },
    },
    statusReports: {
      where: { expiresAt: { gt: now } },
      select: { kind: true, createdAt: true, confirmations: true, userId: true, deviceId: true },
    },
    photos: {
      where: { approved: true },
      orderBy: { createdAt: 'desc' },
      take: 1,
      select: { url: true, thumbUrl: true },
    },
  } satisfies Prisma.ToiletInclude;
}

export type ToiletWithSummary = Prisma.ToiletGetPayload<{
  include: ReturnType<typeof summaryInclude>;
}>;

const reviewInclude = {
  user: { select: { handle: true } },
  photos: { select: { id: true, url: true, thumbUrl: true, approved: true } },
} satisfies Prisma.ReviewInclude;

export type ReviewWithRelations = Prisma.ReviewGetPayload<{ include: typeof reviewInclude }>;

export interface ToiletFilter {
  features?: Feature[];
  tier?: ToiletTier[];
  areaType?: AreaType;
  includePending?: boolean;
  bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number };
}

const ATTRIBUTION: Record<string, string> = {
  OSM: '© OpenStreetMap contributors (ODbL)',
  DATAGOV: 'Data © data.gov.sg, Singapore Open Data Licence',
};

/** Builds ToiletSummary / ToiletDetail / ToiletPin objects. Reusable by any module. */
@Injectable()
export class ToiletPresenter {
  constructor(private readonly prisma: PrismaService) {}

  static readonly summaryInclude = summaryInclude;
  static readonly reviewInclude = reviewInclude;

  /**
   * Prisma where for finder queries: ACTIVE (+PENDING), venue not NONE, all required features
   * present, optional tier/areaType/bbox.
   */
  static where(f: ToiletFilter): Prisma.ToiletWhereInput {
    const and: Prisma.ToiletWhereInput[] = (f.features ?? []).map((feature) => ({
      features: { some: { feature, present: true } },
    }));
    return {
      status: f.includePending ? { in: ['ACTIVE', 'PENDING'] } : 'ACTIVE',
      venue: { toiletStatus: { not: 'NONE' } },
      ...(f.tier?.length ? { tier: { in: f.tier } } : {}),
      ...(f.areaType ? { areaType: f.areaType } : {}),
      ...(f.bbox
        ? {
            latitude: { gte: f.bbox.minLat, lte: f.bbox.maxLat },
            longitude: { gte: f.bbox.minLng, lte: f.bbox.maxLng },
          }
        : {}),
      ...(and.length ? { AND: and } : {}),
    };
  }

  /** Effective opening hours: the toilet's own, else the venue's. */
  static effectiveHours(t: {
    openingHours: unknown;
    venue: { openingHours: unknown };
  }): OpeningHours | null {
    return ((t.openingHours ?? t.venue.openingHours) as OpeningHours | null) ?? null;
  }

  findSummaries(where: Prisma.ToiletWhereInput, now = new Date(), take?: number) {
    return this.prisma.toilet.findMany({ where, include: summaryInclude(now), take });
  }

  venueLite(v: ToiletWithSummary['venue']): ToiletSummary['venue'] {
    return {
      id: v.id,
      name: v.name,
      type: v.type,
      lines: v.lines,
      lat: v.latitude,
      lng: v.longitude,
      toiletStatus: v.toiletStatus,
      note: v.note,
    };
  }

  /** Unexpired reports grouped by kind; unconfirmed anonymous closures are left out (status/unconfirmed.ts). */
  activeStatus(reports: ToiletWithSummary['statusReports']) {
    const byKind = new Map<string, { kind: (typeof reports)[number]['kind']; count: number; latest: Date }>();
    for (const r of countedReports(reports)) {
      const cur = byKind.get(r.kind);
      if (!cur) byKind.set(r.kind, { kind: r.kind, count: 1, latest: r.createdAt });
      else {
        cur.count++;
        if (r.createdAt > cur.latest) cur.latest = r.createdAt;
      }
    }
    return [...byKind.values()]
      .sort((a, b) => b.latest.getTime() - a.latest.getTime())
      .map((s) => ({ kind: s.kind, count: s.count, latestAt: s.latest.toISOString() }));
  }

  toSummary(t: ToiletWithSummary, now = new Date(), origin?: LatLng): ToiletSummary {
    const survey = t.surveys[0];
    const photo = t.photos[0];
    const summary: ToiletSummary = {
      id: t.id,
      label: t.label,
      venue: this.venueLite(t.venue),
      lat: t.latitude,
      lng: t.longitude,
      level: t.level,
      areaType: t.areaType,
      tier: t.tier,
      status: t.status,
      features: t.features.map((f) => f.feature).sort(),
      scoreCleanliness: t.scoreCleanliness,
      surveyTotal: survey?.total ?? null,
      rasStars: survey?.rasStars ?? null,
      reviewCount: t.reviewCount,
      seenBy: t.seenBy,
      activeStatus: this.activeStatus(t.statusReports),
      lastVerifiedAt: t.lastVerifiedAt?.toISOString() ?? null,
      needsResurvey: t.needsResurvey,
      openNow: isOpenAt(ToiletPresenter.effectiveHours(t), now),
      photoThumb: photo ? (photo.thumbUrl ?? photo.url) : null,
    };
    if (origin) {
      const d = haversineM(origin, { lat: t.latitude, lng: t.longitude });
      summary.distanceM = Math.round(d);
      summary.walkSecondsEstimate = estimateWalkSeconds(d);
    }
    return summary;
  }

  toPin(t: {
    id: string;
    latitude: number;
    longitude: number;
    tier: ToiletTier;
    status: ToiletPin['status'];
    scoreCleanliness: number | null;
    venue: { type: ToiletPin['venueType'] };
    statusReports: ToiletWithSummary['statusReports'];
  }): ToiletPin {
    return {
      id: t.id,
      lat: t.latitude,
      lng: t.longitude,
      tier: t.tier,
      status: t.status,
      scoreCleanliness: t.scoreCleanliness,
      hasIssue: countedReports(t.statusReports).some((r) => r.kind !== 'ALL_GOOD'),
      venueType: t.venue.type,
    };
  }

  /** Public reviews show approved photos only; `includeUnapproved` for the author's own view. */
  toReview(r: ReviewWithRelations, includeUnapproved = false): Review {
    return {
      id: r.id,
      cleanliness: r.cleanliness,
      comment: r.comment,
      createdAt: r.createdAt.toISOString(),
      // Always null: the Google profile picture is not shown anywhere public, so it is not sent either.
      // The field stays in the contract until the frontend drops it.
      user: { handle: r.user.handle, avatarUrl: null },
      photos: r.photos
        .filter((p) => includeUnapproved || p.approved)
        .map((p) => ({ id: p.id, url: p.url, thumbUrl: p.thumbUrl })),
    };
  }

  /** Full detail, or null if not found. REJECTED toilets are hidden. */
  async detail(id: string, userId: string | null, now = new Date()): Promise<ToiletDetail | null> {
    const t = await this.prisma.toilet.findUnique({
      where: { id },
      include: {
        ...summaryInclude(now),
        features: { orderBy: { feature: 'asc' } },
        surveys: { orderBy: { surveyedAt: 'desc' }, take: 1 },
        photos: {
          where: { approved: true },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { id: true, url: true, thumbUrl: true },
        },
        reviews: { orderBy: { createdAt: 'desc' }, take: 10, include: reviewInclude },
        _count: { select: { surveys: true } },
        lastVerifiedBy: { select: { handle: true, verifierCredit: true, deletedAt: true } },
      },
    });
    if (!t || t.status === 'REJECTED') return null;
    const mine = userId
      ? await this.prisma.review.findUnique({
          where: { toiletId_userId: { toiletId: id, userId } },
          include: reviewInclude,
        })
      : null;

    const survey = t.surveys[0] ?? null;
    const summary = this.toSummary(
      {
        ...t,
        features: t.features.filter((f) => f.present),
        surveys: survey ? [{ total: survey.total, rasStars: survey.rasStars }] : [],
        photos: t.photos.slice(0, 1),
      },
      now,
    );
    return {
      ...summary,
      venue: { ...summary.venue, address: t.venue.address, planningArea: t.venue.planningArea },
      // Places without an address say where they are ("120 m from Tampines MRT"), as on area pages.
      near: t.venue.address ? null : await nearText(this.prisma, t.venue),
      openSubmissionId:
        t.status === 'PENDING'
          ? ((
              await this.prisma.submission.findFirst({
                where: { toiletId: t.id, kind: 'NEW_TOILET', state: { in: ['PENDING', 'NEEDS_INFO', 'ESCALATED'] } },
                orderBy: { createdAt: 'desc' },
                select: { id: true },
              })
            )?.id ?? null)
          : null,
      accessNote: t.accessNote,
      nearestExit: t.nearestExit,
      openingHours: ToiletPresenter.effectiveHours(t),
      featureDetails: t.features.map((f) => ({
        feature: f.feature,
        present: f.present,
        source: f.source,
        observedAt: f.observedAt.toISOString(),
      })),
      latestSurvey: survey
        ? {
            id: survey.id,
            surveyedAt: survey.surveyedAt.toISOString(),
            phase: survey.phase,
            cleanliness: survey.cleanliness,
            scent: survey.scent,
            aesthetics: survey.aesthetics,
            music: survey.music,
            toiletries: survey.toiletries,
            facilities: survey.facilities,
            total: survey.total,
            rasStars: survey.rasStars,
            remarks: survey.remarks,
          }
        : null,
      surveyCount: t._count.surveys,
      reviews: t.reviews.map((r) => this.toReview(r)),
      photos: t.photos,
      myReview: mine ? this.toReview(mine, true) : null,
      verifiedBy:
        t.lastVerifiedBy?.handle && t.lastVerifiedBy.verifierCredit && !t.lastVerifiedBy.deletedAt
          ? { handle: t.lastVerifiedBy.handle }
          : null,
      source: t.source,
      attribution: ATTRIBUTION[t.source] ?? null,
    };
  }
}
