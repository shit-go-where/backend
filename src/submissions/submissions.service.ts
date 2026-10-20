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
  SubmissionKind,
  SubmissionState,
  ToiletStatus,
  ToiletTier,
  VenueToiletStatus,
  VenueType,
} from '../generated/prisma/enums.js';
import { bboxAround, haversineM, inSingapore, type LatLng } from '../common/geo.js';
import { levelFields, levelsOverlap, normalizeLevel } from '../common/level.js';
import { sgtDayStart } from '../gamification/sgt.js';
import { NEAR_VOTE_M, nearApprovals } from './quorum.js';
import {
  AUTO_PUBLISH_PAUSE_MS,
  MAX_OPEN_SUBMISSIONS,
  OPEN_STATES,
  type FinalState,
  applyResolution,
  assertVotable,
  lockSubmission,
  openSubmissionsWhere,
  pathOf,
  recordVote,
  shouldAutoPublish,
  stillNeeded,
} from './resolution.js';
import { resolutionOf } from './resolution-codes.js';
import {
  EditToiletPayloadSchema,
  SubmissionPayloadSchema,
  type CreateSubmissionBody,
  type EditToiletPayload,
  type ModeratorSubmission,
  type NewToiletPayload,
  type SubmissionView,
} from './submissions.schemas.js';

export const SUBMISSION_TTL_MS = 60 * 86_400_000;
export { MAX_OPEN_SUBMISSIONS };
export const VENUE_SNAP_M = 60;
export const DUPLICATE_RADIUS_M = 15;
const QUEUE_LIMIT = 50;
const MODERATOR_QUEUE_LIMIT = 200;
const DAY_MS = 86_400_000;

function viewInclude() {
  return {
    toilet: {
      select: {
        id: true,
        label: true,
        level: true,
        areaType: true,
        nearestExit: true,
        accessNote: true,
        openingHours: true,
        latitude: true,
        longitude: true,
        venue: { select: { name: true, openingHours: true } },
        features: { select: { feature: true, present: true } },
      },
    },
    venue: true,
    submittedBy: { select: { handle: true } },
    votes: {
      select: { userId: true, value: true, comment: true, distanceM: true, checkInId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    },
    photos: {
      where: { confirmed: true },
      select: { id: true, url: true, thumbUrl: true },
      orderBy: { createdAt: 'asc' },
    },
  } satisfies Prisma.SubmissionInclude;
}
type SubmissionRow = Prisma.SubmissionGetPayload<{ include: ReturnType<typeof viewInclude> }>;

/**
 * Levels match when they share a floor once normalised ("1", "L1" and "Level 1" are one floor;
 * "B1; L3" matches "L3"), or when either is unknown.
 */
export function sameLevel(a: string | null | undefined, b: string | null | undefined): boolean {
  return levelsOverlap(a, b);
}

/** A level someone typed, normalised ("level 3" → "L3"). 400 when nothing of it is left (";"). */
export function cleanLevel(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const level = normalizeLevel(v);
  if (!level) throw new BadRequestException('level must name a floor, e.g. B1 or L3');
  return level;
}

/** The body with its level (NEW_TOILET) or level change (EDIT_TOILET) normalised before anything is stored. */
function withCleanLevel(body: CreateSubmissionBody): CreateSubmissionBody {
  if (body.kind === 'NEW_TOILET' && body.payload.level !== undefined) {
    return { ...body, payload: { ...body.payload, level: cleanLevel(body.payload.level) } };
  }
  if (body.kind === 'EDIT_TOILET' && body.payload.changes.level !== undefined) {
    const changes = { ...body.payload.changes, level: cleanLevel(body.payload.changes.level) };
    return { ...body, payload: { ...body.payload, changes } };
  }
  return body;
}

export const LEVEL_NEEDED_MESSAGE =
  'This place already has a toilet listed. Add the level (for example B1 or L3) so people can tell them apart.';

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

  /** The toilet's current values for the fields an open EDIT_TOILET would change. */
  private currentValues(row: SubmissionRow): SubmissionView['current'] {
    const t = row.toilet;
    if (row.kind !== SubmissionKind.EDIT_TOILET || !t || !OPEN_STATES.includes(row.state)) return null;
    const parsed = EditToiletPayloadSchema.safeParse(row.payload);
    if (!parsed.success) return null;
    const c = parsed.data.changes;
    const have = new Map(t.features.map((f) => [f.feature, f.present]));
    return {
      ...(c.label !== undefined ? { label: t.label } : {}),
      ...(c.level !== undefined ? { level: t.level } : {}),
      ...(c.areaType !== undefined ? { areaType: t.areaType } : {}),
      ...(c.nearestExit !== undefined ? { nearestExit: t.nearestExit } : {}),
      ...(c.accessNote !== undefined ? { accessNote: t.accessNote } : {}),
      ...(c.openingHours !== undefined ? { openingHours: ToiletPresenter.effectiveHours(t) } : {}),
      ...(c.features
        ? {
            features: Object.fromEntries(
              Object.keys(c.features).map((f) => [f, have.get(f as Feature) ?? null]),
            ) as Partial<Record<Feature, boolean | null>>,
          }
        : {}),
    };
  }

  private toView(row: SubmissionRow, me: User, from?: LatLng): SubmissionView {
    const now = Date.now();
    // Past expiry but not yet swept by the expire job: it is headed to the moderators either way.
    const overdue =
      (row.state === SubmissionState.PENDING || row.state === SubmissionState.NEEDS_INFO) &&
      row.expiresAt.getTime() < now;
    const state = overdue ? SubmissionState.ESCALATED : row.state;
    const open = OPEN_STATES.includes(state);
    const myVote = row.votes.find((x) => x.userId === me.id)?.value ?? null;
    const t = row.toilet;
    const v = row.venue;
    const nearby = nearApprovals(row.votes);
    const at = row.submittedLat !== null && row.submittedLng !== null ? { lat: row.submittedLat, lng: row.submittedLng } : null;
    const { code, text } = resolutionOf(row.resolution, row.state);
    return {
      id: row.id,
      kind: row.kind,
      state,
      payload: row.payload as SubmissionView['payload'],
      onSite: row.onSite,
      hasPhoto: row.hasPhoto,
      path: pathOf(row),
      nearbyApprovals: nearby,
      needed: stillNeeded({ ...row, state }, nearby),
      escalated: state === SubmissionState.ESCALATED,
      submitterDistanceM: at && t ? Math.round(haversineM(at, { lat: t.latitude, lng: t.longitude })) : null,
      reviewerNotes: row.votes.map((x) => ({
        value: x.value,
        note: x.comment,
        createdAt: x.createdAt.toISOString(),
        nearby: x.distanceM !== null && x.distanceM <= NEAR_VOTE_M,
        viaCheckIn: x.checkInId !== null,
      })),
      current: this.currentValues(row),
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
      resolution: code,
      resolutionText: text,
      resolutionNote: row.resolutionNote,
      ...(from && t ? { distanceM: Math.round(haversineM(from, { lat: t.latitude, lng: t.longitude })) } : {}),
      myVote,
      photos: row.photos,
      canVote: open && row.resolution !== 'escalated_flagged' && row.submittedById !== me.id && myVote === null,
    };
  }

  async get(id: string, me: User): Promise<SubmissionView> {
    const row = await this.prisma.submission.findUnique({ where: { id }, include: viewInclude() });
    if (!row) throw new NotFoundException('Submission not found');
    return this.toView(row, me);
  }

  async mine(me: User): Promise<{ items: SubmissionView[] }> {
    const rows = await this.prisma.submission.findMany({
      where: { submittedById: me.id },
      include: viewInclude(),
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { items: rows.map((r) => this.toView(r, me)) };
  }

  /** Island-wide moderator queue: escalated first, then oldest first. */
  async moderatorQueue(
    me: User,
    filter: 'pending' | 'escalated' | 'needs_info' | 'all',
  ): Promise<{ items: ModeratorSubmission[] }> {
    const states: Record<typeof filter, SubmissionState[]> = {
      pending: [SubmissionState.PENDING],
      escalated: [SubmissionState.ESCALATED],
      needs_info: [SubmissionState.NEEDS_INFO],
      all: OPEN_STATES,
    };
    const now = new Date();
    const rows = await this.prisma.submission.findMany({
      where: { state: { in: OPEN_STATES } },
      include: viewInclude(),
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    return {
      items: rows
        // One malformed row (hand-made data) must not take the whole island-wide queue down.
        .filter((r) => {
          const ok = SubmissionPayloadSchema.safeParse(r.payload).success;
          if (!ok) this.log.warn(`submission ${r.id} has an invalid payload; left out of the moderator queue`);
          return ok;
        })
        .map((r) => ({
          ...this.toView(r, me),
          ageDays: Math.floor((now.getTime() - r.createdAt.getTime()) / DAY_MS),
        }))
        // Overdue PENDING / NEEDS_INFO read as ESCALATED, so filter on the view's state.
        .filter((v) => states[filter].includes(v.state))
        .sort((a, b) => Number(b.escalated) - Number(a.escalated) || a.createdAt.localeCompare(b.createdAt))
        .slice(0, MODERATOR_QUEUE_LIMIT),
    };
  }

  async queue(me: User, q: { lat: number; lng: number; radius: number }): Promise<{ items: SubmissionView[] }> {
    const from = { lat: q.lat, lng: q.lng };
    const bb = bboxAround(from, q.radius);
    const rows = await this.prisma.submission.findMany({
      where: {
        // Escalated ones stay: a nearby confirmation still settles them before a moderator gets there.
        state: { in: OPEN_STATES },
        OR: [{ resolution: null }, { resolution: { not: 'escalated_flagged' } }],
        submittedById: { not: me.id },
        toilet: { latitude: { gte: bb.minLat, lte: bb.maxLat }, longitude: { gte: bb.minLng, lte: bb.maxLng } },
      },
      include: viewInclude(),
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

  async create(me: User, raw: CreateSubmissionBody): Promise<SubmissionView> {
    const body = withCleanLevel(raw);
    const open = await this.prisma.submission.count({ where: openSubmissionsWhere(me.id) });
    if (open >= MAX_OPEN_SUBMISSIONS) {
      throw new HttpException(
        `You have ${open} submissions from the last 14 days still waiting; wait for some to be reviewed (max ${MAX_OPEN_SUBMISSIONS})`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const at = body.lat !== undefined && body.lng !== undefined ? { lat: body.lat, lng: body.lng } : null;
    let id: string;
    if (body.kind === 'NEW_TOILET') {
      const created = await this.createNewToilet(me, body.payload, at, body.force ?? false);
      id = created.id;
      // An auto-published toilet counts as an approval for badges, as a quorum would.
      if (created.autoPublished) await this.evaluateBadgesFor([me.id]);
    } else id = await this.createForToilet(me, body.kind, body.toiletId, body.payload, at);
    return this.get(id, me);
  }

  /** Inputs to the auto-publish guardrails: today's auto-publishes and any rejection in the last 30 days. */
  private async autoPublishHistory(userId: string, now: Date) {
    const [autoPublishedToday, rejected] = await Promise.all([
      this.prisma.submission.count({
        where: { submittedById: userId, autoPublished: true, createdAt: { gte: sgtDayStart(now) } },
      }),
      this.prisma.submission.count({
        where: {
          submittedById: userId,
          state: SubmissionState.REJECTED,
          resolvedAt: { gt: new Date(now.getTime() - AUTO_PUBLISH_PAUSE_MS) },
        },
      }),
    ]);
    return { autoPublishedToday, rejectedRecently: rejected > 0 };
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

  private async createNewToilet(
    me: User,
    p: NewToiletPayload,
    at: LatLng | null,
    force: boolean,
  ): Promise<{ id: string; autoPublished: boolean }> {
    const here = { lat: p.lat, lng: p.lng };
    if (!inSingapore(here)) throw new BadRequestException('Location must be inside Singapore');
    if (p.venueId && p.newVenue) throw new BadRequestException('Give either venueId or newVenue, not both');
    const photoIds = await this.assertPhotos(me.id, p.photoIds);

    let venueId: string | null = null;
    if (p.venueId) {
      const venue = await this.prisma.venue.findUnique({ where: { id: p.venueId }, select: { id: true } });
      if (!venue) throw new BadRequestException('venueId does not exist');
      venueId = venue.id;
      // Malls and stations have toilets on several floors at one spot: a second toilet at a place
      // someone picked needs its level, or the map can't tell them apart (the 409 guard can't either).
      if (!p.level) {
        const listed = await this.prisma.toilet.count({
          where: { venueId, status: { in: [ToiletStatus.ACTIVE, ToiletStatus.PENDING] } },
        });
        if (listed > 0) throw new BadRequestException(LEVEL_NEEDED_MESSAGE);
      }
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
    // Trust model v2 (PLAN.md §12 E1): on site + photo goes live at once, within the guardrails.
    const onSite = at !== null && haversineM(at, here) <= NEAR_VOTE_M;
    const hasPhoto = photoIds.length > 0;
    const autoPublished =
      onSite && hasPhoto && shouldAutoPublish({ onSite, hasPhoto, ...(await this.autoPublishHistory(me.id, now)) });
    const id = await this.prisma.$transaction(async (tx) => {
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
          onSite,
          hasPhoto,
          autoPublished,
          ...(autoPublished
            ? { state: SubmissionState.APPROVED, resolvedAt: now, resolution: 'auto_on_site_photo' }
            : {}),
          expiresAt: new Date(now.getTime() + SUBMISSION_TTL_MS),
        },
      });
      const toilet = await tx.toilet.create({
        data: {
          venueId,
          label: p.label ?? null,
          latitude: p.lat,
          longitude: p.lng,
          ...levelFields(p.level),
          areaType: p.areaType ?? AreaType.UNKNOWN,
          accessNote: p.accessNote ?? null,
          tier: ToiletTier.COMMUNITY,
          status: autoPublished ? ToiletStatus.ACTIVE : ToiletStatus.PENDING,
          lastVerifiedAt: autoPublished ? now : null,
          seenBy: 1,
          source: DataSource.COMMUNITY,
          sourceKey: `community:${submission.id}`,
          createdById: me.id,
        },
      });
      // +5 now; the other 15 come when a second person checks in (resolution.ts confirmByCheckIn).
      if (autoPublished) await this.points.award(me.id, 'NEW_TOILET_SUBMITTED', submission.id, { tx });
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
    return { id, autoPublished };
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
    const onSite = at !== null && haversineM(at, { lat: toilet.latitude, lng: toilet.longitude }) <= NEAR_VOTE_M;
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
          onSite,
          hasPhoto: photoIds.length > 0,
          expiresAt: new Date(Date.now() + SUBMISSION_TTL_MS),
        },
      });
      if (photoIds.length > 0) {
        await tx.photo.updateMany({ where: { id: { in: photoIds } }, data: { submissionId: submission.id, toiletId } });
      }
      return submission.id;
    });
  }

  /* ─────────────── needs info ─────────────── */

  /**
   * The submitter answers NEEDS_INFO: a note, more photos and/or a corrected level. The submission
   * goes back to PENDING with a fresh 60 days; REJECT votes are cleared so those reviewers can look
   * again, APPROVE votes (and check-in confirmations) stay.
   */
  async update(
    me: User,
    id: string,
    raw: { note?: string; photoIds?: string[]; level?: string },
  ): Promise<SubmissionView> {
    const body = { ...raw, level: cleanLevel(raw.level) };
    const sub = await this.prisma.submission.findUnique({ where: { id } });
    if (!sub || sub.submittedById !== me.id) throw new NotFoundException('Submission not found');
    if (sub.state !== SubmissionState.NEEDS_INFO) {
      throw new ConflictException('Only a submission that needs more info can be changed');
    }
    if (body.level !== undefined && sub.kind === SubmissionKind.CLOSE_TOILET) {
      throw new BadRequestException('A closure report has no level to change');
    }
    const photoIds = await this.assertPhotos(me.id, body.photoIds ?? []);
    const payload = { ...(sub.payload as Record<string, unknown>) };
    if (body.note !== undefined) payload.note = body.note;
    if (photoIds.length > 0) {
      payload.photoIds = [...new Set([...((payload.photoIds as string[] | undefined) ?? []), ...photoIds])];
    }
    if (body.level !== undefined) {
      if (sub.kind === SubmissionKind.EDIT_TOILET) {
        payload.changes = { ...(payload.changes as Record<string, unknown>), level: body.level };
      } else payload.level = body.level;
    }
    await this.prisma.$transaction(async (tx) => {
      await lockSubmission(tx, id);
      await tx.submissionVote.deleteMany({ where: { submissionId: id, value: 'REJECT' } });
      const approvals = await tx.submissionVote.count({ where: { submissionId: id, value: 'APPROVE' } });
      await tx.submission.update({
        where: { id },
        data: {
          payload: payload as Prisma.InputJsonValue,
          state: SubmissionState.PENDING,
          resolution: null,
          resolutionNote: null,
          approvals,
          rejections: 0,
          hasPhoto: sub.hasPhoto || photoIds.length > 0,
          expiresAt: new Date(Date.now() + SUBMISSION_TTL_MS),
        },
      });
      if (photoIds.length > 0) {
        await tx.photo.updateMany({
          where: { id: { in: photoIds } },
          data: { submissionId: id, ...(sub.toiletId ? { toiletId: sub.toiletId } : {}) },
        });
      }
      if (body.level !== undefined && sub.kind === SubmissionKind.NEW_TOILET && sub.toiletId) {
        await tx.toilet.update({ where: { id: sub.toiletId }, data: levelFields(body.level) });
      }
    });
    return this.get(id, me);
  }

  /* ─────────────── votes & resolution ─────────────── */

  async vote(
    me: User,
    id: string,
    body: { value: 'APPROVE' | 'REJECT'; comment?: string; lat?: number; lng?: number },
  ): Promise<SubmissionView> {
    const toEvaluate = await this.prisma.$transaction(async (tx) => {
      const sub = await lockSubmission(tx, id);
      if (sub.submittedById === me.id) throw new ForbiddenException('You cannot vote on your own submission');
      // Expiry no longer closes voting: an escalated submission can still be settled by people nearby.
      assertVotable(sub);
      const existing = await tx.submissionVote.findUnique({ where: { submissionId_userId: { submissionId: id, userId: me.id } } });
      if (existing) throw new ConflictException('You already voted on this submission');

      const distanceM =
        body.lat !== undefined && body.lng !== undefined && sub.toilet
          ? Math.round(haversineM({ lat: body.lat, lng: body.lng }, { lat: sub.toilet.latitude, lng: sub.toilet.longitude }))
          : null;
      const r = await recordVote(tx, this.points, sub, me, { value: body.value, comment: body.comment, distanceM });
      return r.evaluate;
    });
    await this.evaluateBadgesFor(toEvaluate);
    return this.get(id, me);
  }

  async resolve(moderator: User, id: string, body: { state: FinalState; note?: string }): Promise<SubmissionView> {
    const toEvaluate = await this.prisma.$transaction(async (tx) => {
      const sub = await lockSubmission(tx, id);
      if (!OPEN_STATES.includes(sub.state)) throw new ConflictException(`Submission is already ${sub.state}`);
      const code = ({ APPROVED: 'moderator_approved', REJECTED: 'moderator_rejected', NEEDS_INFO: 'moderator_needs_info' } as const)[
        body.state
      ];
      return applyResolution(tx, this.points, sub, body.state, moderator.id, code, body.note ?? null);
    });
    await this.evaluateBadgesFor(toEvaluate);
    return this.get(id, moderator);
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
