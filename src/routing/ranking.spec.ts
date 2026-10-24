import {
  DEFAULT_WEIGHTS,
  URGENT_WEIGHTS,
  ago,
  byWalkMinutes,
  cost,
  isBlocked,
  issuePenalty,
  needPenalty,
  rank,
  reasons,
  resolveWeights,
  type RankCandidate,
} from './ranking.js';
import { PURPOSES, PURPOSE_NEEDS } from './purposes.js';

const now = new Date('2026-10-18T12:00:00Z');
const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);

function cand(over: Partial<RankCandidate> = {}): RankCandidate {
  return {
    id: 'x',
    distanceM: 300,
    scoreCleanliness: 7,
    tier: 'VERIFIED',
    source: 'FIELDWORK_2024',
    lastVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    features: [],
    reports: [],
    ...over,
  };
}

describe('isBlocked', () => {
  it('single unconfirmed CLOSED_NOW/BROKEN does not block', () => {
    expect(isBlocked([{ kind: 'CLOSED_NOW', createdAt: now, confirmations: 0 }])).toBe(false);
    expect(isBlocked([{ kind: 'BROKEN', createdAt: now, confirmations: 0 }])).toBe(false);
  });
  it('confirmed or repeated reports block', () => {
    expect(isBlocked([{ kind: 'CLOSED_NOW', createdAt: now, confirmations: 1 }])).toBe(true);
    expect(
      isBlocked([
        { kind: 'BROKEN', createdAt: now, confirmations: 0 },
        { kind: 'BROKEN', createdAt: now, confirmations: 0 },
      ]),
    ).toBe(true);
  });
  it('other kinds never block', () => {
    expect(
      isBlocked([
        { kind: 'NO_PAPER', createdAt: now, confirmations: 5 },
        { kind: 'NO_PAPER', createdAt: now, confirmations: 5 },
      ]),
    ).toBe(false);
  });
});

describe('issuePenalty', () => {
  it('counts each kind once and caps at 1', () => {
    const r = (kind: RankCandidate['reports'][number]['kind']) => ({ kind, createdAt: now, confirmations: 0 });
    expect(issuePenalty([])).toBe(0);
    expect(issuePenalty([r('ALL_GOOD')])).toBe(0);
    expect(issuePenalty([r('NO_PAPER'), r('NO_PAPER')])).toBe(0.5);
    expect(issuePenalty([r('NO_PAPER'), r('NO_SOAP'), r('LONG_QUEUE')])).toBe(1);
  });
});

describe('cost', () => {
  it('nearer is better, all else equal', () => {
    expect(cost(cand({ distanceM: 100 }), 1500, DEFAULT_WEIGHTS, now)).toBeLessThan(
      cost(cand({ distanceM: 900 }), 1500, DEFAULT_WEIGHTS, now),
    );
  });
  it('cleaner is better; null uses a neutral default between', () => {
    const clean = cost(cand({ scoreCleanliness: 9 }), 1500, DEFAULT_WEIGHTS, now);
    const unknown = cost(cand({ scoreCleanliness: null }), 1500, DEFAULT_WEIGHTS, now);
    const dirty = cost(cand({ scoreCleanliness: 2 }), 1500, DEFAULT_WEIGHTS, now);
    expect(clean).toBeLessThan(unknown);
    expect(unknown).toBeLessThan(dirty);
  });
  it('tier: VERIFIED < COMMUNITY < IMPORTED', () => {
    const c = (tier: RankCandidate['tier']) => cost(cand({ tier }), 1500, DEFAULT_WEIGHTS, now);
    expect(c('VERIFIED')).toBeLessThan(c('COMMUNITY'));
    expect(c('COMMUNITY')).toBeLessThan(c('IMPORTED'));
  });
  it('stale and never-verified are penalised', () => {
    const fresh = cost(cand({ lastVerifiedAt: minsAgo(60) }), 1500, DEFAULT_WEIGHTS, now);
    const old = cost(cand({ lastVerifiedAt: new Date('2023-01-01') }), 1500, DEFAULT_WEIGHTS, now);
    const never = cost(cand({ lastVerifiedAt: null }), 1500, DEFAULT_WEIGHTS, now);
    expect(fresh).toBeLessThan(old);
    expect(old).toBeLessThanOrEqual(never);
  });
  it('stays within 0..1', () => {
    const worst = cand({
      distanceM: 99_999,
      scoreCleanliness: 0,
      tier: 'IMPORTED',
      lastVerifiedAt: null,
      reports: [
        { kind: 'NO_PAPER', createdAt: now, confirmations: 0 },
        { kind: 'LONG_QUEUE', createdAt: now, confirmations: 0 },
        { kind: 'NO_SOAP', createdAt: now, confirmations: 0 },
      ],
    });
    expect(cost(worst, 1500, DEFAULT_WEIGHTS, now)).toBeCloseTo(1);
    expect(cost(cand({ distanceM: 0, scoreCleanliness: 10, lastVerifiedAt: now }), 1500, DEFAULT_WEIGHTS, now)).toBe(0);
  });
});

describe('rank', () => {
  it('prefers a clean toilet slightly further away in normal mode, nearest in urgent mode', () => {
    const near = cand({ id: 'near', distanceM: 200, scoreCleanliness: 2 });
    const far = cand({ id: 'far', distanceM: 450, scoreCleanliness: 9.5 });
    expect(rank([near, far], 1500, DEFAULT_WEIGHTS, now)[0].candidate.id).toBe('far');
    expect(rank([near, far], 800, URGENT_WEIGHTS, now)[0].candidate.id).toBe('near');
  });
  it('drops blocked toilets and returns a 0-100 score', () => {
    const blocked = cand({ id: 'b', distanceM: 10, reports: [{ kind: 'CLOSED_NOW', createdAt: now, confirmations: 2 }] });
    const ok = cand({ id: 'ok', distanceM: 500 });
    const r = rank([blocked, ok], 1500, DEFAULT_WEIGHTS, now);
    expect(r.map((x) => x.candidate.id)).toEqual(['ok']);
    expect(r[0].score).toBeGreaterThan(0);
    expect(r[0].score).toBeLessThanOrEqual(100);
  });
  it('a no-paper report pushes a toilet down', () => {
    const a = cand({ id: 'a', distanceM: 300, reports: [{ kind: 'NO_PAPER', createdAt: now, confirmations: 0 }] });
    const b = cand({ id: 'b', distanceM: 350 });
    expect(rank([a, b], 1500, DEFAULT_WEIGHTS, now)[0].candidate.id).toBe('b');
  });
});

describe('purpose needs', () => {
  it('needPenalty is the missing share of preferred importance', () => {
    const prefer = { BABY_CHANGE: 3, NURSING_ROOM: 1 } as const;
    expect(needPenalty(['BABY_CHANGE', 'NURSING_ROOM'], prefer)).toBe(0);
    expect(needPenalty(['BABY_CHANGE'], prefer)).toBe(0.25);
    expect(needPenalty([], prefer)).toBe(1);
    expect(needPenalty([], {})).toBe(0);
  });
  it('without needs, cost is unchanged', () => {
    const c = cand({ features: ['SHOWER'] });
    expect(cost(c, 1500, DEFAULT_WEIGHTS, now, undefined)).toBe(cost(c, 1500, DEFAULT_WEIGHTS, now));
  });
  it('shower purpose puts a further toilet with a shower first', () => {
    const near = cand({ id: 'near', distanceM: 100 });
    const far = cand({ id: 'far', distanceM: 1400, features: ['SHOWER'] });
    expect(rank([near, far], 1500, DEFAULT_WEIGHTS, now)[0].candidate.id).toBe('near');
    expect(rank([near, far], 1500, DEFAULT_WEIGHTS, now, PURPOSE_NEEDS.SHOWER)[0].candidate.id).toBe('far');
  });
  it('every purpose keeps a toilet with a must-have-free profile rankable', () => {
    for (const p of PURPOSES) {
      const k = cost(cand(), 1500, DEFAULT_WEIGHTS, now, PURPOSE_NEEDS[p]);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(1);
    }
  });
  it('a quick pee shrugs off no paper but not a queue', () => {
    const noPaper = [{ kind: 'NO_PAPER' as const, createdAt: now, confirmations: 0 }];
    expect(issuePenalty(noPaper, PURPOSE_NEEDS.PEE.issues)).toBeLessThan(issuePenalty(noPaper));
    const queue = [{ kind: 'LONG_QUEUE' as const, createdAt: now, confirmations: 0 }];
    expect(issuePenalty(queue, PURPOSE_NEEDS.PEE.issues)).toBeGreaterThan(issuePenalty(queue));
  });
});

describe('resolveWeights', () => {
  it('urgent ignores overrides', () => {
    expect(resolveWeights(true, { cleanliness: 1 })).toEqual(URGENT_WEIGHTS);
  });
  it('merges overrides onto defaults', () => {
    expect(resolveWeights(false, { cleanliness: 0.9, distance: undefined })).toEqual({
      ...DEFAULT_WEIGHTS,
      cleanliness: 0.9,
    });
  });
});

describe('reasons', () => {
  it('builds human-readable reasons', () => {
    const c = cand({
      features: ['BIDET', 'ACCESSIBLE', 'TOILET_PAPER'],
      scoreCleanliness: 8.2,
      reports: [{ kind: 'NO_PAPER', createdAt: minsAgo(40), confirmations: 0 }],
    });
    expect(reasons(c, 240, ['ACCESSIBLE'], now)).toEqual([
      '4 min walk',
      'Accessible',
      'Bidet',
      'Clean 8.2/10',
      'Reported: no paper 40 min ago',
      'Verified 2024 survey',
    ]);
  });
  it('lists preferred features after required ones', () => {
    const c = cand({ features: ['MIRROR', 'HAND_SOAP', 'BIDET'], scoreCleanliness: null });
    expect(reasons(c, 60, [], now, ['HAND_SOAP', 'MIRROR', 'HAND_DRYER'])).toEqual([
      '1 min walk',
      'Soap',
      'Mirror',
      'Bidet',
      'Verified 2024 survey',
    ]);
  });
  it('labels both 2024 fieldwork surveys the same', () => {
    expect(reasons(cand({ scoreCleanliness: null, source: 'FIELDWORK_2024_EXPANDED' }), 60, [], now)).toEqual([
      '1 min walk',
      'Verified 2024 survey',
    ]);
  });
  it('handles unknown cleanliness and other tiers', () => {
    expect(reasons(cand({ scoreCleanliness: null, tier: 'IMPORTED', source: 'OSM' }), 20, [], now)).toEqual([
      '1 min walk',
      'From OpenStreetMap',
    ]);
    expect(reasons(cand({ tier: 'COMMUNITY', source: 'COMMUNITY' }), 600, [], now)).toContain('Community verified');
  });
  it('ago formats minutes and hours', () => {
    expect(ago(minsAgo(0), now)).toBe('just now');
    expect(ago(minsAgo(5), now)).toBe('5 min ago');
    expect(ago(minsAgo(130), now)).toBe('2 h ago');
  });
});

describe('byWalkMinutes', () => {
  it('puts the shortest walk first, whatever the straight-line ranking said', () => {
    const items = [
      { id: 'mcd', walkSeconds: 300, score: 90 },
      { id: 'nsl', walkSeconds: 170, score: 80 },
      { id: 'nel', walkSeconds: 190, score: 85 },
    ];
    expect(byWalkMinutes(items).map((i) => i.id)).toEqual(['nel', 'nsl', 'mcd']);
  });

  it('keeps the better-ranked toilet first within the same walk minute', () => {
    const items = [
      { id: 'a', walkSeconds: 130, score: 60 },
      { id: 'b', walkSeconds: 100, score: 90 },
    ];
    expect(byWalkMinutes(items).map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('does not reorder the input array', () => {
    const items = [
      { id: 'a', walkSeconds: 600, score: 1 },
      { id: 'b', walkSeconds: 60, score: 1 },
    ];
    byWalkMinutes(items);
    expect(items[0].id).toBe('a');
  });
});
