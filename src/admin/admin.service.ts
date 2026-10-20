import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma, type User } from '../generated/prisma/client.js';
import {
  AreaType,
  DataSource,
  Role,
  SubmissionState,
  ToiletStatus,
  type Feature,
} from '../generated/prisma/enums.js';
import { hasRole } from '../common/auth/auth.guard.js';
import { MediaService } from '../media/media.service.js';
import { toPhotoRef } from '../media/photo-urls.js';
import { recomputeAllScores } from '../toilets/scoring.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { levelFields } from '../common/level.js';
import type { JobName } from './admin.dto.js';

/** TRUSTED approvals needed to publish a photo (a single MODERATOR+ approval publishes). */
export const TRUSTED_PHOTO_QUORUM = 2;
export const STATUS_ARCHIVE_AFTER_MS = 7 * 86_400_000;
const STALE_MS = 365 * 86_400_000;

export interface ToiletPatch {
  status?: ToiletStatus;
  label?: string | null;
  areaType?: AreaType;
  level?: string | null;
  accessNote?: string | null;
  needsResurvey?: boolean;
  features?: Partial<Record<Feature, boolean>>;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly metrics: MetricsService,
  ) {}

  // ───────── flags ─────────

  async listFlags(resolved: boolean) {
    const flags = await this.prisma.flag.findMany({
      where: { resolved },
      orderBy: { createdAt: resolved ? 'desc' : 'asc' },
      take: 200,
      include: {
        toilet: { select: { id: true, label: true, venue: { select: { name: true } } } },
        user: { select: { handle: true } },
      },
    });
    return {
      items: flags.map((f) => ({
        id: f.id,
        reason: f.reason,
        createdAt: f.createdAt.toISOString(),
        resolved: f.resolved,
        toilet: { id: f.toilet.id, label: f.toilet.label, venueName: f.toilet.venue.name },
        user: { handle: f.user.handle },
      })),
    };
  }

  async resolveFlag(id: string) {
    const r = await this.prisma.flag.updateMany({
      where: { id },
      data: { resolved: true, resolvedAt: new Date() },
    });
    if (r.count === 0) throw new NotFoundException('Flag not found');
    return { ok: true as const };
  }

  // ───────── photos ─────────

  async pendingPhotos() {
    const photos = await this.prisma.photo.findMany({
      where: { confirmed: true, approved: false },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return {
      items: photos.map((p) => ({
        ...toPhotoRef(p),
        createdAt: p.createdAt.toISOString(),
        toiletId: p.toiletId,
        submissionId: p.submissionId,
        reviewId: p.reviewId,
        approvals: p.approvals,
      })),
    };
  }

  async approvePhoto(user: User, photoId: string) {
    const photo = await this.prisma.photo.findUnique({ where: { id: photoId } });
    if (!photo || !photo.confirmed) throw new NotFoundException('Photo not found');
    if (photo.approved) return { approved: true, approvals: photo.approvals };
    if (photo.uploadedById === user.id && !hasRole(user, Role.ADMIN)) {
      throw new ForbiddenException('You cannot approve your own photo');
    }
    const moderator = hasRole(user, Role.MODERATOR);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // PK (photoId, userId) makes a second approval by the same user fail atomically.
        await tx.photoApproval.create({ data: { photoId, userId: user.id } });
        const p = await tx.photo.update({
          where: { id: photoId },
          data: { approvals: { increment: 1 } },
        });
        const publish = moderator || p.approvals >= TRUSTED_PHOTO_QUORUM;
        if (!publish) return { approved: false, approvals: p.approvals };
        await tx.photo.update({ where: { id: photoId }, data: { approved: true } });
        return { approved: true, approvals: p.approvals };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('You already approved this photo');
      }
      throw e;
    }
  }

  async rejectPhoto(photoId: string) {
    const photo = await this.prisma.photo.findUnique({ where: { id: photoId } });
    if (!photo) throw new NotFoundException('Photo not found');
    await this.media.deletePhotoObjects(photo);
    // PhotoApproval rows cascade with the photo.
    await this.prisma.photo.delete({ where: { id: photoId } });
    return { ok: true as const };
  }

  // ───────── toilets / users ─────────

  async patchToilet(id: string, patch: ToiletPatch) {
    const exists = await this.prisma.toilet.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Toilet not found');
    const { features, level, ...rest } = patch;
    // Admin edits go through the same level normalisation as everyone else's.
    const fields = level !== undefined ? { ...rest, ...levelFields(level) } : rest;
    const now = new Date();
    const featureWrites = Object.entries(features ?? {}).map(([feature, present]) =>
      this.prisma.toiletFeature.upsert({
        where: { toiletId_feature: { toiletId: id, feature: feature as Feature } },
        create: {
          toiletId: id,
          feature: feature as Feature,
          present: present as boolean,
          source: DataSource.ADMIN,
          observedAt: now,
        },
        update: { present: present as boolean, source: DataSource.ADMIN, observedAt: now },
      }),
    );
    await this.prisma.$transaction([
      this.prisma.toilet.update({ where: { id }, data: fields }),
      ...featureWrites,
    ]);
    return { id };
  }

  async setRole(actor: User, userId: string, role: Role) {
    if (actor.id === userId) throw new BadRequestException('You cannot change your own role');
    const r = await this.prisma.user.updateMany({ where: { id: userId }, data: { role } });
    if (r.count === 0) throw new NotFoundException('User not found');
    return { id: userId, role };
  }

  // ───────── ops ─────────

  async listImports() {
    const runs = await this.prisma.importRun.findMany({ orderBy: { startedAt: 'desc' }, take: 50 });
    return {
      items: runs.map((r) => ({
        id: r.id,
        source: r.source,
        command: r.command,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        inserted: r.inserted,
        updated: r.updated,
        skipped: r.skipped,
        log: r.log ?? null,
      })),
    };
  }

  async dataQuality() {
    const now = new Date();
    const live = { status: ToiletStatus.ACTIVE };
    const [
      toilets,
      venues,
      pending,
      escalated,
      flagsOpen,
      photosPending,
      noFeatures,
      stale365d,
      needsResurvey,
      unknownAreaType,
    ] = await Promise.all([
      this.prisma.toilet.count({ where: { status: { not: ToiletStatus.REJECTED } } }),
      this.prisma.venue.count(),
      this.prisma.submission.count({
        where: {
          state: { in: [SubmissionState.PENDING, SubmissionState.NEEDS_INFO] },
          expiresAt: { gt: now },
        },
      }),
      this.prisma.submission.count({ where: { state: SubmissionState.ESCALATED } }),
      this.prisma.flag.count({ where: { resolved: false } }),
      this.prisma.photo.count({ where: { confirmed: true, approved: false } }),
      this.prisma.toilet.count({ where: { ...live, features: { none: {} } } }),
      this.prisma.toilet.count({
        where: {
          ...live,
          OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: new Date(now.getTime() - STALE_MS) } }],
        },
      }),
      this.prisma.toilet.count({ where: { ...live, needsResurvey: true } }),
      this.prisma.toilet.count({ where: { ...live, areaType: AreaType.UNKNOWN } }),
    ]);
    return {
      counts: {
        toilets,
        venues,
        pending,
        escalated,
        flagsOpen,
        photosPending,
        noFeatures,
        stale365d,
        needsResurvey,
        unknownAreaType,
      },
    };
  }

  async runJob(name: JobName, now = new Date()): Promise<{ ok: true; affected: number }> {
    switch (name) {
      case 'expire-submissions':
        return { ok: true, affected: await this.expireSubmissions(now) };
      case 'archive-status': {
        const r = await this.prisma.statusReport.deleteMany({
          where: { expiresAt: { lt: new Date(now.getTime() - STATUS_ARCHIVE_AFTER_MS) } },
        });
        return { ok: true, affected: r.count };
      }
      case 'recompute-scores':
        return { ok: true, affected: await recomputeAllScores(this.prisma) };
      case 'metrics':
        await this.metrics.computeYesterday(now);
        return { ok: true, affected: 1 };
    }
  }

  /**
   * PENDING / NEEDS_INFO past expiresAt → ESCALATED for moderators (PLAN.md §12: moderation is a
   * safety net, expiry never deletes). Their toilets stay PENDING, so they still show as unconfirmed
   * and a nearby check-in can still confirm them.
   */
  private async expireSubmissions(now: Date): Promise<number> {
    const r = await this.prisma.submission.updateMany({
      where: {
        state: { in: [SubmissionState.PENDING, SubmissionState.NEEDS_INFO] },
        expiresAt: { lt: now },
      },
      data: { state: SubmissionState.ESCALATED, escalatedAt: now, resolution: 'escalated_expired', resolutionNote: null },
    });
    return r.count;
  }
}
