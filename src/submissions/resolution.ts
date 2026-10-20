/**
 * How submissions get decided (trust model v2, PLAN.md §12 E1/E2). Plain functions over a Prisma
 * transaction rather than a Nest provider, so both SubmissionsService (votes, moderators) and
 * GamificationService (check-ins that confirm a pending toilet) can use them without a module cycle.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import {
  DataSource,
  Feature,
  type Role,
  SubmissionKind,
  SubmissionState,
  ToiletStatus,
  VenueToiletStatus,
} from '../generated/prisma/enums.js';
import type { PointsService } from '../gamification/points.service.js';
import { recomputeToiletScore } from '../toilets/scoring.js';
import { levelFields } from '../common/level.js';
import { NEAR_VOTE_M, evaluateQuorum, nearApprovals, nearNeeded } from './quorum.js';
import { CloseToiletPayloadSchema, EditToiletPayloadSchema } from './submissions.schemas.js';
import type { ResolutionCode } from './resolution-codes.js';

export type Tx = Prisma.TransactionClient;
export type FinalState = 'APPROVED' | 'REJECTED' | 'NEEDS_INFO';

/** States that can still be voted on, confirmed by a check-in, or resolved by a moderator. */
export const OPEN_STATES: SubmissionState[] = [
  SubmissionState.PENDING,
  SubmissionState.NEEDS_INFO,
  SubmissionState.ESCALATED,
];
/** On-site + photo auto-publishes at most this many toilets per person per Singapore day. */
export const MAX_AUTO_PUBLISH_PER_DAY = 3;
/** No auto-publish for this long after one of your submissions was rejected. */
export const AUTO_PUBLISH_PAUSE_MS = 30 * 86_400_000;
/** Distinct people (other than the submitter) whose flags send an auto-published toilet back to pending. */
export const FLAGS_TO_ESCALATE = 2;
/** Open submissions a person may have at once... */
export const MAX_OPEN_SUBMISSIONS = 10;
/** ...counting only those from the last 14 days, so old unanswered ones never lock anyone out. */
export const OPEN_CAP_WINDOW_MS = 14 * 86_400_000;

/** The submissions that count toward MAX_OPEN_SUBMISSIONS. */
export function openSubmissionsWhere(userId: string, now = new Date()): Prisma.SubmissionWhereInput {
  return {
    submittedById: userId,
    state: { in: OPEN_STATES },
    createdAt: { gt: new Date(now.getTime() - OPEN_CAP_WINDOW_MS) },
  };
}

/* ─────────────── paths ─────────────── */

export type SubmissionPath = 'auto' | 'on_site_check_in' | 'nearby_quorum';

/** Which rule decides this submission. Pure. */
export function pathOf(s: { kind: SubmissionKind; onSite: boolean; autoPublished: boolean }): SubmissionPath {
  if (s.autoPublished) return 'auto';
  if (s.kind === SubmissionKind.NEW_TOILET && s.onSite) return 'on_site_check_in';
  return 'nearby_quorum';
}

/** More nearby confirmations needed to go live; 0 once decided or while only a moderator can decide. Pure. */
export function stillNeeded(
  s: { kind: SubmissionKind; onSite: boolean; autoPublished: boolean; state: SubmissionState; resolution: string | null },
  nearby: number,
): number {
  if (!OPEN_STATES.includes(s.state) || s.autoPublished || s.resolution === 'escalated_flagged') return 0;
  return Math.max(0, nearNeeded(s.kind, s.onSite) - nearby);
}

/**
 * Whether a new toilet goes live at once (PLAN.md §12 E1). Pure.
 * Needs: submitted within 150 m of the pin, at least one photo, fewer than 3 auto-publishes today,
 * and no rejected submission in the last 30 days. Otherwise it waits for a confirmation.
 */
export function shouldAutoPublish(i: {
  onSite: boolean;
  hasPhoto: boolean;
  autoPublishedToday: number;
  rejectedRecently: boolean;
}): boolean {
  return i.onSite && i.hasPhoto && i.autoPublishedToday < MAX_AUTO_PUBLISH_PER_DAY && !i.rejectedRecently;
}

/* ─────────────── transactions ─────────────── */

/** Row lock + load, so concurrent votes / check-ins on one submission serialise. */
export async function lockSubmission(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "Submission" WHERE id = ${id} FOR UPDATE`;
  const sub = await tx.submission.findUnique({
    where: { id },
    include: { toilet: { select: { latitude: true, longitude: true } } },
  });
  if (!sub) throw new NotFoundException('Submission not found');
  return sub;
}
export type LockedSubmission = Awaited<ReturnType<typeof lockSubmission>>;

const featureRows = (features: Partial<Record<Feature, boolean>>) =>
  Object.entries(features)
    .filter((e): e is [Feature, boolean] => typeof e[1] === 'boolean')
    .map(([feature, present]) => ({ feature, present }));

/**
 * Applies a decision inside the caller's transaction: state, toilet effects, points, scores.
 * Returns the user ids whose badges should be re-evaluated after commit.
 */
export async function applyResolution(
  tx: Tx,
  points: PointsService,
  sub: Pick<LockedSubmission, 'id' | 'kind' | 'toiletId' | 'submittedById' | 'payload' | 'autoPublished'>,
  state: FinalState,
  resolvedById: string | null,
  code: ResolutionCode,
  note: string | null = null,
): Promise<string[]> {
  const now = new Date();
  await tx.submission.update({
    where: { id: sub.id },
    data: {
      state,
      resolvedAt: state === 'NEEDS_INFO' ? null : now,
      resolvedById: state === 'NEEDS_INFO' ? null : resolvedById,
      resolution: code,
      resolutionNote: note,
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
          ...(changes.level !== undefined ? levelFields(changes.level) : {}),
          ...(changes.areaType !== undefined ? { areaType: changes.areaType } : {}),
          ...(changes.nearestExit !== undefined ? { nearestExit: changes.nearestExit } : {}),
          ...(changes.accessNote !== undefined ? { accessNote: changes.accessNote } : {}),
          ...(changes.openingHours !== undefined ? { openingHours: changes.openingHours } : {}),
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
    // An auto-published toilet already earned NEW_TOILET_SUBMITTED (5); its approval is the
    // missing 15, so the total stays at SUBMISSION_APPROVED's 20.
    if (sub.autoPublished) await points.award(sub.submittedById, 'NEW_TOILET_CONFIRMED', sub.id, { tx });
    else await points.award(sub.submittedById, 'SUBMISSION_APPROVED', sub.id, { tx });
    evaluate.add(sub.submittedById);
  }
  const winning = state === 'APPROVED' ? 'APPROVE' : 'REJECT';
  const matched = await tx.submissionVote.findMany({ where: { submissionId: sub.id, value: winning }, select: { userId: true } });
  for (const { userId } of matched) {
    await points.award(userId, 'VOTE_MATCHED_OUTCOME', sub.id, { tx });
    evaluate.add(userId);
  }
  if (toiletId && state === 'APPROVED') await recomputeToiletScore(tx, toiletId);
  return [...evaluate];
}

/**
 * Records a vote and runs the quorum, inside the caller's transaction (the submission must be locked).
 * Returns the outcome it applied, if any, and the users whose badges to re-evaluate.
 */
export async function recordVote(
  tx: Tx,
  points: PointsService,
  sub: LockedSubmission,
  voter: { id: string },
  v: { value: 'APPROVE' | 'REJECT'; comment?: string | null; distanceM: number | null; checkInId?: string | null },
): Promise<{ outcome: FinalState | null; evaluate: string[] }> {
  await tx.submissionVote.create({
    data: {
      submissionId: sub.id,
      userId: voter.id,
      value: v.value,
      comment: v.comment ?? null,
      distanceM: v.distanceM,
      checkInId: v.checkInId ?? null,
    },
  });
  const votes = await tx.submissionVote.findMany({
    where: { submissionId: sub.id },
    select: { value: true, distanceM: true, checkInId: true, user: { select: { role: true } } },
  });
  await tx.submission.update({
    where: { id: sub.id },
    data: {
      approvals: votes.filter((x) => x.value === 'APPROVE').length,
      rejections: votes.filter((x) => x.value === 'REJECT').length,
    },
  });
  const quorumVotes = votes.map((x) => ({ value: x.value, distanceM: x.distanceM, role: x.user.role as Role }));
  const outcome = evaluateQuorum(sub.kind, quorumVotes, { onSite: sub.onSite });
  if (outcome === 'APPROVED') {
    const byNearby = nearApprovals(quorumVotes) >= nearNeeded(sub.kind, sub.onSite);
    const byCheckIn = votes.some((x) => x.checkInId && x.value === 'APPROVE');
    const code: ResolutionCode = !byNearby
      ? 'trusted_approved'
      : sub.kind === 'NEW_TOILET' && sub.onSite && byCheckIn
        ? 'confirmed_on_site'
        : 'community_approved';
    return { outcome, evaluate: await applyResolution(tx, points, sub, outcome, voter.id, code) };
  }
  if (outcome === 'REJECTED') {
    return { outcome, evaluate: await applyResolution(tx, points, sub, outcome, voter.id, 'moderator_rejected') };
  }
  if (outcome === 'NEEDS_INFO' && sub.state !== SubmissionState.NEEDS_INFO) {
    await tx.submission.update({
      where: { id: sub.id },
      data: { state: SubmissionState.NEEDS_INFO, resolution: 'peer_needs_info', resolutionNote: null },
    });
    return { outcome, evaluate: [] };
  }
  return { outcome: null, evaluate: [] };
}

/** Peers can still vote (moderators resolve flagged ones alone). Throws 409 otherwise. */
export function assertVotable(sub: Pick<LockedSubmission, 'state' | 'resolution'>): void {
  if (!OPEN_STATES.includes(sub.state)) throw new ConflictException('Voting on this submission is closed');
  if (sub.resolution === 'escalated_flagged') {
    throw new ConflictException('A moderator is reviewing this toilet after it was flagged');
  }
}

export interface CheckInConfirmation {
  /** This check-in counted as a confirmation of someone's new toilet. */
  confirmedPending: boolean;
  /** ...and that confirmation put the toilet live. */
  wentLive: boolean;
  evaluate: string[];
}

/**
 * A signed-in check-in within 150 m of a new toilet someone else added counts as an APPROVE vote
 * (PLAN.md §12 E1): it can put a pending toilet live, and on an auto-published one it is the second
 * person that earns the submitter the remaining 15 points. Runs inside the check-in's transaction.
 */
export async function confirmByCheckIn(
  tx: Tx,
  points: PointsService,
  c: { toiletId: string; userId: string; distanceM: number; checkInId: string },
): Promise<CheckInConfirmation> {
  const none: CheckInConfirmation = { confirmedPending: false, wentLive: false, evaluate: [] };
  if (c.distanceM > NEAR_VOTE_M) return none;
  const found = await tx.submission.findFirst({
    where: {
      toiletId: c.toiletId,
      kind: SubmissionKind.NEW_TOILET,
      OR: [{ state: { in: OPEN_STATES } }, { state: SubmissionState.APPROVED, autoPublished: true }],
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!found) return none;
  const sub = await lockSubmission(tx, found.id);
  if (sub.submittedById === c.userId) return none;
  const voted = await tx.submissionVote.findUnique({
    where: { submissionId_userId: { submissionId: sub.id, userId: c.userId } },
    select: { value: true },
  });
  if (voted) return none;

  if (sub.state === SubmissionState.APPROVED) {
    // Already live (auto-published): record who confirmed it and pay the submitter the rest.
    await tx.submissionVote.create({
      data: { submissionId: sub.id, userId: c.userId, value: 'APPROVE', distanceM: c.distanceM, checkInId: c.checkInId },
    });
    await tx.submission.update({ where: { id: sub.id }, data: { approvals: { increment: 1 } } });
    await points.award(sub.submittedById, 'NEW_TOILET_CONFIRMED', sub.id, { tx });
    return { confirmedPending: true, wentLive: false, evaluate: [sub.submittedById] };
  }
  if (sub.resolution === 'escalated_flagged') return none;
  const r = await recordVote(tx, points, sub, { id: c.userId }, {
    value: 'APPROVE',
    distanceM: c.distanceM,
    checkInId: c.checkInId,
  });
  return { confirmedPending: true, wentLive: r.outcome === 'APPROVED', evaluate: r.evaluate };
}

/**
 * When FLAGS_TO_ESCALATE distinct people (not the submitter) have open flags on an auto-published
 * toilet, it goes back to PENDING and its submission to the moderator queue. Returns true if it did.
 */
export async function escalateIfFlagged(prisma: PrismaClient, toiletId: string): Promise<boolean> {
  const sub = await prisma.submission.findFirst({
    where: { toiletId, kind: SubmissionKind.NEW_TOILET, autoPublished: true, state: SubmissionState.APPROVED },
    select: { id: true, submittedById: true, createdAt: true },
  });
  if (!sub) return false;
  const flaggers = await prisma.flag.findMany({
    where: { toiletId, resolved: false, createdAt: { gte: sub.createdAt }, userId: { not: sub.submittedById } },
    distinct: ['userId'],
    select: { userId: true },
  });
  if (flaggers.length < FLAGS_TO_ESCALATE) return false;
  const now = new Date();
  await prisma.$transaction([
    prisma.toilet.updateMany({ where: { id: toiletId, status: ToiletStatus.ACTIVE }, data: { status: ToiletStatus.PENDING } }),
    prisma.submission.updateMany({
      where: { id: sub.id, state: SubmissionState.APPROVED },
      data: {
        state: SubmissionState.ESCALATED,
        escalatedAt: now,
        resolvedAt: null,
        resolvedById: null,
        resolution: 'escalated_flagged',
      },
    }),
  ]);
  return true;
}
