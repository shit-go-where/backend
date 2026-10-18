import type { Prisma, PrismaClient } from '../generated/prisma/client.js';

type Db = PrismaClient | Prisma.TransactionClient;

const DAY_MS = 86_400_000;
const decay = (ageMs: number, halfLifeDays: number) =>
  Math.pow(0.5, ageMs / (halfLifeDays * DAY_MS));

/**
 * Blended cleanliness 0-10.
 * - Latest survey cleanliness (0-10), weight 3, half-life 365 days.
 * - Each review (1-5 mapped to 2-10), weight 1, half-life 180 days, latest 50.
 * Null when there is no data at all.
 */
export function blendCleanliness(
  survey: { cleanliness: number; surveyedAt: Date } | null,
  reviews: { cleanliness: number; createdAt: Date }[],
  now = new Date(),
): number | null {
  let w = 0;
  let sum = 0;
  if (survey) {
    const sw = 3 * decay(now.getTime() - survey.surveyedAt.getTime(), 365);
    w += sw;
    sum += sw * survey.cleanliness;
  }
  for (const r of reviews) {
    const rw = decay(now.getTime() - r.createdAt.getTime(), 180);
    w += rw;
    sum += rw * r.cleanliness * 2;
  }
  if (w === 0) return null;
  return Math.round((sum / w) * 10) / 10;
}

/** Recompute Toilet.scoreCleanliness and Toilet.reviewCount. Call after review/survey writes. */
export async function recomputeToiletScore(db: Db, toiletId: string): Promise<void> {
  const [survey, reviews, reviewCount] = await Promise.all([
    db.survey.findFirst({
      where: { toiletId },
      orderBy: { surveyedAt: 'desc' },
      select: { cleanliness: true, surveyedAt: true },
    }),
    db.review.findMany({
      where: { toiletId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { cleanliness: true, createdAt: true },
    }),
    db.review.count({ where: { toiletId } }),
  ]);
  await db.toilet.update({
    where: { id: toiletId },
    data: { scoreCleanliness: blendCleanliness(survey, reviews), reviewCount },
  });
}

/** Recompute every toilet. Used by the recompute-scores job and after imports. */
export async function recomputeAllScores(db: Db): Promise<number> {
  const ids = await db.toilet.findMany({ select: { id: true } });
  for (const { id } of ids) await recomputeToiletScore(db, id);
  return ids.length;
}
