import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PointsService } from '../gamification/points.service.js';
import { GamificationService } from '../gamification/gamification.service.js';
import { ToiletPresenter } from '../toilets/toilet-presenter.service.js';
import type { Prisma, User } from '../generated/prisma/client.js';
import {
  AreaType,
  DataSource,
  Feature,
  SubmissionState,
  ToiletStatus,
  ToiletTier,
  VenueToiletStatus,
  VenueType,
} from '../generated/prisma/enums.js';
import { bboxAround, haversineM, inSingapore, type LatLng } from '../common/geo.js';
import { recomputeToiletScore } from '../toilets/scoring.js';
import { NEAR_VOTE_M, evaluateQuorum } from './quorum.js';
import {
  EditToiletPayloadSchema,
  CloseToiletPayloadSchema,
  type CreateSubmissionBody,
  type EditToiletPayload,
  type NewToiletPayload,
  type SubmissionView,
} from './submissions.schemas.js';

export const SUBMISSION_TTL_MS = 60 * 86_400_000;
export const MAX_OPEN_SUBMISSIONS = 10;
export const VENUE_SNAP_M = 60;
export const DUPLICATE_RADIUS_M = 15;
const QUEUE_LIMIT = 50;
const OPEN_STATES: SubmissionState[] = [SubmissionState.PENDING, SubmissionState.NEEDS_INFO];

type Tx = Prisma.TransactionClient;
type FinalState = 'APPROVED' | 'REJECTED' | 'NEEDS_INFO';

function viewInclude(userId: string) {
  return {
    toilet: {
      select: { id: true, label: true, latitude: true, longitude: true, venue: { select: { name: true } } },
    },
    venue: true,
    submittedBy: { select: { handle: true } },
    votes: { where: { userId }, select: { value: true } },
    photos: {
      where: { confirmed: true },
      select: { id: true, url: true, thumbUrl: true },
      orderBy: { createdAt: 'asc' },
    },
  } satisfies Prisma.SubmissionInclude;
}
type SubmissionRow = Prisma.SubmissionGetPayload<{ include: ReturnType<typeof viewInclude> }>;

/** Levels match when equal (case/space-insensitive) or when either is unknown. */
export function sameLevel(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (s: string | null | undefined) => (s ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return !n(a) || !n(b) || n(a) === n(b);
}

const featureRows = (features: Partial<Record<Feature, boolean>>) =>
  Object.entries(features)
    .filter((e): e is [Feature, boolean] => typeof e[1] === 'boolean')
    .map(([feature, present]) => ({ feature, present }));

@Injectable()
export class SubmissionsService {
  private readonly log = new Logger(SubmissionsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PointsService) private readonly points: PointsService,
    @Inject(GamificationService) private readonly gamification: GamificationService,
    @Inject(ToiletPresenter) private readonly presenter: ToiletPresenter,
  ) {}

  /* ─────────────── views ─────────────── */

  private toView(row: SubmissionRow, me: User, from?: LatLng): SubmissionView {
    const now = Date.now();
    const open = OPEN_STATES.includes(row.state);
    const expired = open && row.expiresAt.getTime() < now;
    const myVote = row.votes[0]?.value ?? null;
    const t = row.toilet;
    const v = row.venue;
    return {
      id: row.id,
      kind: row.kind,
      state: expired ? SubmissionState.EXPIRED : row.state,
      payload: row.payload as SubmissionView['payload'],
      toilet: t ? { id: t.id, label: t.label, venueName: t.venue.name, lat: t.latitude, lng: t.longitude } : null,
      venue: v
        ? {
            id: v.id,
            name: v.name,
            type: v.type,
            lines: v.lines,
            lat: v.latitude,
            lng: v.longitude,
            toiletStatus: v.toiletStatus,
            note: v.note,
          }
        : null,
      submittedBy: { handle: row.submittedBy.handle },
      approvals: row.approvals,
      rejections: row.rejections,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolution: row.resolution,
      ...(from && t ? { distanceM: Math.round(haversineM(from, { lat: t.latitude, lng: t.longitude })) } : {}),
      myVote,
      photos: row.photos,
      canVote: open && !expired && row.submittedById !== me.id && myVote === null,
    };
  }

  async get(id: string, me: User): Promise<SubmissionView> {
    const row = await this.prisma.submission.findUnique({ where: { id }, include: viewInclude(me.id) });
    if (!row) throw new NotFoundException('Submission not found');
    return this.toView(row, me);
  }

  async mine(me: User): Promise<{ items: SubmissionView[] }> {
    const rows = await this.prisma.submission.findMany({
      where: { submittedById: me.id },
      include: viewInclude(me.id),
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { items: rows.map((r) => this.toView(r, me)) };
  }

  async queue(me: User, q: { lat: number; lng: number; radius: number }): Promise<{ items: SubmissionView[] }> {
    const from = { lat: q.lat, lng: q.lng };
    const bb = bboxAround(from, q.radius);
    const rows = await this.prisma.submission.findMany({
      where: {
        state: { in: OPEN_STATES },
        expiresAt: { gt: new Date() },
        submittedById: { not: me.id },
        toilet: { latitude: { gte: bb.minLat, lte: bb.maxLat }, longitude: { gte: bb.minLng, lte: bb.maxLng } },
      },
      include: viewInclude(me.id),
      take: 1000,
    });
    const items = rows
      .map((r) => this.toView(r, me, from))
      .filter((v) => v.distanceM !== undefined && v.distanceM <= q.radius)
      .sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0))
      .slice(0, QUEUE_LIMIT);
    return { items };
  }

  /* ─────────────── create ─────────────── */

  async create(me: User, body: CreateSubmissionBody): Promise<SubmissionView> {
    const open = await this.prisma.submission.count({
      where: { submittedById: me.id, state: { in: OPEN_STATES }, expiresAt: { gt: new Date() } },
    });
    if (open >= MAX_OPEN_SUBMISSIONS) {
      throw new HttpException(
        `You have ${open} open submissions; wait for some to be reviewed (max ${MAX_OPEN_SUBMISSIONS})`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const at = body.lat !== undefined && body.lng !== undefined ? { lat: body.lat, lng: body.lng } : null;
    let id: string;
    if (body.kind === 'NEW_TOILET') id = await this.createNewToilet(me, body.payload, at, body.force ?? false);
    else id = await this.createForToilet(me, body.kind, body.toiletId, body.payload, at);
    return this.get(id, me);
  }

  private async assertPhotos(userId: string, photoIds: string[]): Promise<string[]> {
    const ids = [...new Set(photoIds)];
    if (ids.length === 0) return ids;
    const found = await this.prisma.photo.count({
      where: { id: { in: ids }, uploadedById: userId, confirmed: true, submissionId: null },
    });
    if (found !== ids.length) {
      throw new BadRequestException('photoIds must be your own confirmed photos not attached to another submission');
    }
    return ids;
  }

  private async createNewToilet(me: User, p: NewToiletPayload, at: LatLng | null, force: boolean): Promise<string> {
    const here = { lat: p.lat, lng: p.lng };
    if (!inSingapore(here)) throw new BadRequestException('Location must be inside Singapore');
    if (p.venueId && p.newVenue) throw new BadRequestException('Give either venueId or newVenue, not both');
    const photoIds = await this.assertPhotos(me.id, p.photoIds);

    let venueId: string | null = null;
    if (p.venueId) {
      const venue = await this.prisma.venue.findUnique({ where: { id: p.venueId }, select: { id: true } });
      if (!venue) throw new BadRequestException('venueId does not exist');
      venueId = venue.id;
    } else if (!p.newVenue) {
      const bb = bboxAround(here, VENUE_SNAP_M);
      const candidates = await this.prisma.venue.findMany({
        where: { latitude: { gte: bb.minLat, lte: bb.maxLat }, longitude: { gte: bb.minLng, lte: bb.maxLng } },
        select: { id: true, latitude: true, longitude: true },
      });
      const nearest = candidates
        .map((v) => ({ id: v.id, d: haversineM(here, { lat: v.latitude, lng: v.longitude }) }))
        .filter((v) => v.d <= VENUE_SNAP_M)
        .sort((a, b) => a.d - b.d)[0];
      venueId = nearest?.id ?? null;
    }

    if (venueId && !force) {
      const bb = bboxAround(here, DUPLICATE_RADIUS_M);
      const near = await this.prisma.toilet.findMany({
        where: {
          venueId,
          status: { in: [ToiletStatus.ACTIVE, ToiletStatus.PENDING] },
          latitude: { gte: bb.minLat, lte: bb.maxLat },
          longitude: { gte: bb.minLng, lte: bb.maxLng },
        },
        select: { id: true, latitude: true, longitude: true, level: true },
      });
      const dupes = near.filter(
        (t) => haversineM(here, { lat: t.latitude, lng: t.longitude }) <= DUPLICATE_RADIUS_M && sameLevel(t.level, p.level),
      );
      if (dupes.length > 0) {
        const now0 = new Date();
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: 'A toilet is already listed here. Resubmit with force: true if this is a different one.',
          candidateIds: dupes.map((t) => t.id),
          // Full summaries so the add wizard can show what is already listed here.
          candidates: (await this.presenter.findSummaries({ id: { in: dupes.map((t) => t.id) } })).map((t) =>
            this.presenter.toSummary(t, now0, here),
          ),
        });
      }
    }

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      if (!venueId) {
        const venue = await tx.venue.create({
          data: {
            name: p.newVenue?.name ?? p.label ?? 'Unnamed place',
            type: p.newVenue?.type ?? VenueType.OTHER,
            latitude: p.lat,
            longitude: p.lng,
            toiletStatus: VenueToiletStatus.HAS_TOILETS,
            source: DataSource.COMMUNITY,
            sourceKey: `community-venue:tmp-${crypto.randomUUID()}`,
          },
        });
        await tx.venue.update({ where: { id: venue.id }, data: { sourceKey: `community-venue:${venue.id}` } });
        venueId = venue.id;
      }
      const submission = await tx.submission.create({
        data: {
          kind: 'NEW_TOILET',
          venueId,
          payload: { ...p, venueId, photoIds } as Prisma.InputJsonValue,
          submittedById: me.id,
          submittedLat: at?.lat ?? null,
          submittedLng: at?.lng ?? null,
          expiresAt: new Date(now.getTime() + SUBMISSION_TTL_MS),
        },
      });
      const toilet = await tx.toilet.create({
        data: {
          venueId,
          label: p.label ?? null,
          latitude: p.lat,
          longitude: p.lng,
          level: p.level ?? null,
          areaType: p.areaType ?? AreaType.UNKNOWN,
          accessNote: p.accessNote ?? null,
          tier: ToiletTier.COMMUNITY,
          status: ToiletStatus.PENDING,
          source: DataSource.COMMUNITY,
          sourceKey: `community:${submission.id}`,
          createdById: me.id,
        },
      });
      const rows = featureRows(p.features);
      if (rows.length > 0) {
        await tx.toiletFeature.createMany({
          data: rows.map((r) => ({ ...r, toiletId: toilet.id, source: DataSource.COMMUNITY, observedAt: now })),
        });
      }
      await tx.photo.updateMany({ where: { id: { in: photoIds } }, data: { submissionId: submission.id, toiletId: toilet.id } });
      await tx.submission.update({ where: { id: submission.id }, data: { toiletId: toilet.id } });
      return submission.id;
    });
  }

  private async createForToilet(
    me: User,
    kind: 'EDIT_TOILET' | 'CLOSE_TOILET',
    toiletId: string | undefined,
    payload: EditToiletPayload | { status: 'CLOSED' | 'RENOVATION'; reason: string },
    at: LatLng | null,
  ): Promise<string> {
    if (!toiletId) throw new BadRequestException(`${kind} needs toiletId`);
    const toilet = await this.prisma.toilet.findUnique({
      where: { id: toiletId },
      select: { id: true, status: true, venueId: true, latitude: true, longitude: true },
    });
    if (!toilet) throw new NotFoundException('Toilet not found');
    if (toilet.status !== ToiletStatus.ACTIVE) throw new BadRequestException('Only active toilets can be edited or closed');
    // Edits describe what's inside, so only someone standing at the toilet can propose one,
    // within the same radius as check-ins and nearby votes.
    if (kind === 'EDIT_TOILET') {
      if (!at) throw new BadRequestException('EDIT_TOILET needs lat/lng: you must be at the toilet to edit it');
      const distanceM = Math.round(haversineM(at, { lat: toilet.latitude, lng: toilet.longitude }));
      if (distanceM > NEAR_VOTE_M) {
        throw new BadRequestException(`You are ${distanceM} m from this toilet; you need to be within ${NEAR_VOTE_M} m to edit it`);
      }
    }
    const photoIds = 'changes' in payload ? await this.assertPhotos(me.id, payload.photoIds ?? []) : [];
    return this.prisma.$transaction(async (tx) => {
      const submission = await tx.submission.create({
        data: {
          kind,
          toiletId,
          venueId: toilet.venueId,
          payload: payload as Prisma.InputJsonValue,
          submittedById: me.id,
          submittedLat: at?.lat ?? null,
          submittedLng: at?.lng ?? null,
          expiresAt: new Date(Date.now() + SUBMISSION_TTL_MS),
        },
      });
      if (photoIds.length > 0) {
        await tx.photo.updateMany({ where: { id: { in: photoIds } }, data: { submissionId: submission.id, toiletId } });
      }
      return submission.id;
    });
  }

  /* ─────────────── votes & resolution ─────────────── */

  private async lock(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM "Submission" WHERE id = ${id} FOR UPDATE`;
    const sub = await tx.submission.findUnique({
      where: { id },
      include: { toilet: { select: { latitude: true, longitude: true } } },
    });
    if (!sub) throw new NotFoundException('Submission not found');
    return sub;
  }

  async vote(
    me: User,
    id: string,
    body: { value: 'APPROVE' | 'REJECT'; comment?: string; lat?: number; lng?: number },
  ): Promise<SubmissionView> {
    const toEvaluate = await this.prisma.$transaction(async (tx) => {
      const sub = await this.lock(tx, id);
      if (sub.submittedById === me.id) throw new ForbiddenException('You cannot vote on your own submission');
      if (!OPEN_STATES.includes(sub.state) || sub.expiresAt.getTime() < Date.now()) {
        throw new ConflictException('Voting on this submission is closed');
      }
      const existing = await tx.submissionVote.findUnique({ where: { submissionId_userId: { submissionId: id, userId: me.id } } });
      if (existing) throw new ConflictException('You already voted on this submission');

      const distanceM =
        body.lat !== undefined && body.lng !== undefined && sub.toilet
          ? Math.round(haversineM({ lat: body.lat, lng: body.lng }, { lat: sub.toilet.latitude, lng: sub.toilet.longitude }))
          : null;
      await tx.submissionVote.create({
        data: { submissionId: id, userId: me.id, value: body.value, comment: body.comment ?? null, distanceM },
      });
      const votes = await tx.submissionVote.findMany({
        where: { submissionId: id },
        select: { value: true, distanceM: true, user: { select: { role: true } } },
      });
      await tx.submission.update({
        where: { id },
        data: {
          approvals: votes.filter((v) => v.value === 'APPROVE').length,
          rejections: votes.filter((v) => v.value === 'REJECT').length,
        },
      });
      const outcome = evaluateQuorum(
        sub.kind,
        votes.map((v) => ({ value: v.value, distanceM: v.distanceM, role: v.user.role })),
      );
      if (outcome === 'APPROVED' || outcome === 'REJECTED') {
        const note = outcome === 'APPROVED' ? 'Approved by community vote' : 'Rejected by moderator vote';
        return this.applyResolution(tx, sub, outcome, me.id, note);
      }
      if (outcome === 'NEEDS_INFO' && sub.state !== SubmissionState.NEEDS_INFO) {
        await tx.submission.update({
          where: { id },
          data: { state: SubmissionState.NEEDS_INFO, resolution: 'Two reviewers rejected it; more info needed' },
        });
      }
      return [];
    });
    await this.evaluateBadgesFor(toEvaluate);
    return this.get(id, me);
  }

  async resolve(moderator: User, id: string, body: { state: FinalState; note?: string }): Promise<SubmissionView> {
    const toEvaluate = await this.prisma.$transaction(async (tx) => {
      const sub = await this.lock(tx, id);
      if (!OPEN_STATES.includes(sub.state)) throw new ConflictException(`Submission is already ${sub.state}`);
      return this.applyResolution(tx, sub, body.state, moderator.id, body.note ?? `${body.state} by moderator`);
    });
    await this.evaluateBadgesFor(toEvaluate);
    return this.get(id, moderator);
  }

  /**
   * Applies a decision inside the caller's transaction: state, toilet effects, points, scores.
   * Returns the user ids whose badges should be re-evaluated after commit.
   */
  private async applyResolution(
    tx: Tx,
    sub: { id: string; kind: string; toiletId: string | null; submittedById: string; payload: Prisma.JsonValue },
    state: FinalState,
    resolvedById: string,
    note: string,
  ): Promise<string[]> {
    const now = new Date();
    await tx.submission.update({
      where: { id: sub.id },
      data: {
        state,
        resolvedAt: state === 'NEEDS_INFO' ? null : now,
        resolvedById: state === 'NEEDS_INFO' ? null : resolvedById,
        resolution: note,
      },
    });
    if (state === 'NEEDS_INFO') return [];

    const toiletId = sub.toiletId;
    if (state === 'APPROVED' && toiletId) {
      if (sub.kind === 'NEW_TOILET') {
        const t = await tx.toilet.update({
          where: { id: toiletId },
          data: { status: ToiletStatus.ACTIVE, lastVerifiedAt: now },
          select: { venueId: true },
        });
        await tx.venue.update({ where: { id: t.venueId }, data: { toiletStatus: VenueToiletStatus.HAS_TOILETS } });
      } else if (sub.kind === 'EDIT_TOILET') {
        const { changes } = EditToiletPayloadSchema.parse(sub.payload);
        await tx.toilet.update({
          where: { id: toiletId },
          data: {
            ...(changes.label !== undefined ? { label: changes.label } : {}),
            ...(changes.level !== undefined ? { level: changes.level } : {}),
            ...(changes.areaType !== undefined ? { areaType: changes.areaType } : {}),
            ...(changes.accessNote !== undefined ? { accessNote: changes.accessNote } : {}),
            lastVerifiedAt: now,
          },
        });
        for (const { feature, present } of featureRows(changes.features ?? {})) {
          await tx.toiletFeature.upsert({
            where: { toiletId_feature: { toiletId, feature } },
            create: { toiletId, feature, present, source: DataSource.COMMUNITY, observedAt: now },
            update: { present, source: DataSource.COMMUNITY, observedAt: now },
          });
        }
      } else if (sub.kind === 'CLOSE_TOILET') {
        const { status } = CloseToiletPayloadSchema.parse(sub.payload);
        await tx.toilet.update({ where: { id: toiletId }, data: { status } });
      }
    } else if (state === 'REJECTED' && toiletId && sub.kind === 'NEW_TOILET') {
      await tx.toilet.update({ where: { id: toiletId }, data: { status: ToiletStatus.REJECTED } });
    }

    const evaluate = new Set<string>();
    if (state === 'APPROVED') {
      await this.points.award(sub.submittedById, 'SUBMISSION_APPROVED', sub.id, { tx });
      evaluate.add(sub.submittedById);
    }
    const winning = state === 'APPROVED' ? 'APPROVE' : 'REJECT';
    const matched = await tx.submissionVote.findMany({ where: { submissionId: sub.id, value: winning }, select: { userId: true } });
    for (const { userId } of matched) {
      await this.points.award(userId, 'VOTE_MATCHED_OUTCOME', sub.id, { tx });
      evaluate.add(userId);
    }
    if (toiletId && state === 'APPROVED') await recomputeToiletScore(tx, toiletId);
    return [...evaluate];
  }

  private async evaluateBadgesFor(userIds: string[]) {
    for (const userId of userIds) {
      try {
        await this.gamification.evaluateBadges(userId);
      } catch (err) {
        this.log.warn(`badge evaluation failed for ${userId}: ${String(err)}`);
      }
    }
  }
}
