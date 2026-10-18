/**
 * Why someone is going, as soft ranking preferences. The frontend's purpose picker sends one of
 * these; distance vs cleanliness stays with the user's own slider (it gets a per-purpose default).
 *
 * Preferences, not filters: feature coverage is thin (a handful of showers, no nursing rooms on
 * record), so a hard requirement would usually return nothing. Hard must-haves stay in `require`.
 */
import type { RankNeeds } from './ranking.js';

export const PURPOSES = ['PEE', 'POO', 'BABY', 'SHOWER', 'FRESHEN_UP', 'PERIOD'] as const;
export type Purpose = (typeof PURPOSES)[number];

export const PURPOSE_NEEDS: Record<Purpose, RankNeeds> = {
  // In and out: a queue hurts, missing paper hardly does.
  PEE: { prefer: {}, weight: 0, issues: { NO_PAPER: 0.1, LONG_QUEUE: 0.6 } },
  POO: { prefer: { TOILET_PAPER: 2, BIDET: 1, SITTING: 1 }, weight: 0.15, issues: { NO_PAPER: 0.8 } },
  // Strong enough that a baby change a few minutes further beats a toilet next door without one.
  BABY: { prefer: { BABY_CHANGE: 3, NURSING_ROOM: 1, ACCESSIBLE: 1 }, weight: 0.8 },
  // A toilet without a shower is useless here, so this outweighs almost any walk.
  SHOWER: { prefer: { SHOWER: 1 }, weight: 1 },
  FRESHEN_UP: { prefer: { HAND_SOAP: 2, MIRROR: 2, HAND_DRYER: 1 }, weight: 0.3, issues: { NO_SOAP: 0.7 } },
  PERIOD: {
    prefer: { SANITARY_BIN: 2, PERIOD_PRODUCTS: 2, HAND_SOAP: 1, TOILET_PAPER: 1 },
    weight: 0.4,
    issues: { NO_PAPER: 0.7, NO_SOAP: 0.5 },
  },
};
