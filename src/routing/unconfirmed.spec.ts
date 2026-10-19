import type { RankCandidate, Ranked } from './ranking.js';
import { rankUnconfirmedLower, unconfirmedReasons } from './unconfirmed.js';

const cand = (id: string, distanceM: number): RankCandidate => ({
  id,
  distanceM,
  scoreCleanliness: null,
  tier: 'COMMUNITY',
  source: 'COMMUNITY',
  lastVerifiedAt: null,
  features: [],
  reports: [],
});
const ranked = (c: RankCandidate, cost: number): Ranked<RankCandidate> => ({ candidate: c, cost, score: 0 });

describe('unconfirmed toilets in calm results', () => {
  it('rank below an active toilet at a similar distance', () => {
    const pending = cand('pending', 100);
    const active = cand('active', 200);
    const out = rankUnconfirmedLower([ranked(pending, 0.3), ranked(active, 0.33)], (c) => c.id === 'pending');
    expect(out.map((r) => r.candidate.id)).toEqual(['active', 'pending']);
    expect(out[1].score).toBe(Math.round(100 * (1 - 0.4)));
  });

  it('can still lead when the active ones are much worse', () => {
    const out = rankUnconfirmedLower([ranked(cand('pending', 50), 0.2), ranked(cand('far', 1400), 0.6)], (c) => c.id === 'pending');
    expect(out[0].candidate.id).toBe('pending');
  });

  it('say they are unconfirmed instead of community verified', () => {
    expect(unconfirmedReasons(['3 min walk', 'Community verified'])).toEqual([
      '3 min walk',
      'Unconfirmed: added by the community, not yet confirmed',
    ]);
  });
});
