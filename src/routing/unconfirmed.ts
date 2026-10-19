/**
 * Pending (unconfirmed) community toilets in calm results (PLAN.md §12 E1). Pure.
 * They are never recommended in urgent mode; in calm mode they rank below active toilets at a
 * similar distance and are labelled so the UI can say "Unconfirmed".
 */
import { toScore, type RankCandidate, type Ranked } from './ranking.js';

/** Extra cost for a pending toilet: about 330 m of walking at the default weights and 1.5 km radius. */
export const UNCONFIRMED_PENALTY = 0.1;

export function rankUnconfirmedLower<C extends RankCandidate>(
  ranked: Ranked<C>[],
  isUnconfirmed: (c: C) => boolean,
): Ranked<C>[] {
  return ranked
    .map((r) => {
      if (!isUnconfirmed(r.candidate)) return r;
      const cost = r.cost + UNCONFIRMED_PENALTY;
      return { ...r, cost, score: toScore(cost) };
    })
    .sort((a, b) => a.cost - b.cost || a.candidate.distanceM - b.candidate.distanceM);
}

/** The tier reason would say "Community verified"; a pending toilet is not verified yet. */
export function unconfirmedReasons(reasons: string[]): string[] {
  return [...reasons.filter((r) => r !== 'Community verified'), 'Unconfirmed: added by the community, not yet confirmed'];
}
