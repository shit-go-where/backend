import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PointsService } from '../gamification/points.service.js';
import { ToiletPresenter } from '../toilets/toilet-presenter.service.js';
import { recomputeToiletScore } from '../toilets/scoring.js';
import type { Review } from '../toilets/toilet.schemas.js';

export interface ReviewInput {
  cleanliness: number;
  comment?: string;
  photoIds?: string[];
}

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly points: PointsService,
    private readonly presenter: ToiletPresenter,
  ) {}

  private async assertToilet(toiletId: string) {
    const t = await this.prisma.toilet.findUnique({ where: { id: toiletId }, select: { status: true } });
    if (!t || t.status === 'REJECTED') throw new NotFoundException('Toilet not found');
  }

  /** Newest first, cursor = id of the last review on the previous page. */
  async list(toiletId: string, cursor: string | undefined, limit: number) {
    await this.assertToilet(toiletId);
    const rows = await this.prisma.review.findMany({
      where: { toiletId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: ToiletPresenter.reviewInclude,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => this.presenter.toReview(r)),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** Upsert one review per user per toilet, attach photos, award points, recompute score. */
  async upsert(toiletId: string, userId: string, input: ReviewInput): Promise<Review> {
    await this.assertToilet(toiletId);
    const photoIds = input.photoIds ? [...new Set(input.photoIds)] : undefined;

    const review = await this.prisma.$transaction(async (tx) => {
      if (photoIds?.length) {
        const existing = await tx.review.findUnique({
          where: { toiletId_userId: { toiletId, userId } },
          select: { id: true },
        });
        // Own, confirmed, and not already used for another review or another toilet.
        const ok = await tx.photo.findMany({
          where: {
            id: { in: photoIds },
            uploadedById: userId,
            confirmed: true,
            AND: [
              { OR: [{ reviewId: null }, ...(existing ? [{ reviewId: existing.id }] : [])] },
              { OR: [{ toiletId: null }, { toiletId }] },
            ],
          },
          select: { id: true },
        });
        if (ok.length !== photoIds.length) {
          throw new BadRequestException('photoIds must be your own confirmed uploads');
        }
      }
      const r = await tx.review.upsert({
        where: { toiletId_userId: { toiletId, userId } },
        create: { toiletId, userId, cleanliness: input.cleanliness, comment: input.comment ?? null },
        update: { cleanliness: input.cleanliness, comment: input.comment ?? null },
      });
      if (photoIds) {
        // photoIds given = the full set: detach photos no longer listed, attach the rest.
        await tx.photo.updateMany({
          where: { reviewId: r.id, id: { notIn: photoIds } },
          data: { reviewId: null },
        });
        if (photoIds.length) {
          await tx.photo.updateMany({
            where: { id: { in: photoIds } },
            data: { reviewId: r.id, toiletId },
          });
        }
      }
      await this.points.award(userId, 'REVIEW_POSTED', r.id, { tx });
      const photoCount = await tx.photo.count({ where: { reviewId: r.id } });
      if (photoCount > 0) await this.points.award(userId, 'REVIEW_WITH_PHOTO', r.id, { tx });
      await recomputeToiletScore(tx, toiletId);
      return tx.review.findUniqueOrThrow({
        where: { id: r.id },
        include: ToiletPresenter.reviewInclude,
      });
    });
    // The author sees their own photos even before moderation.
    return this.presenter.toReview(review, true);
  }
}
