import { DEFAULT_WEIGHTS, URGENT_WEIGHTS, byWalkMinutes, rank, type RankCandidate } from './ranking.js';
import {
  SECONDS_PER_FLOOR,
  SECONDS_PER_FLOOR_FROM_GROUND,
  floorReason,
  floorSeconds,
  secondsAsStraightM,
} from './levels.js';
import { estimateWalkSeconds } from '../common/geo.js';

const now = new Date('2026-10-18T12:00:00Z');

function cand(over: Partial<RankCandidate> = {}): RankCandidate {
  return {
    id: 'x',
    distanceM: 50,
    scoreCleanliness: 7,
    tier: 'VERIFIED',
    source: 'FIELDWORK_2024',
    lastVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    features: [],
    reports: [],
    ...over,
  };
}

describe('floorSeconds', () => {
  it('40 s per floor from the floor they are on', () => {
    expect(SECONDS_PER_FLOOR).toBe(40);
    expect(floorSeconds('B1', -1)).toBe(0);
    expect(floorSeconds('B1', -2)).toBe(40);
    // No level 0: B1 to L1 is one floor.
    expect(floorSeconds('B1', 1)).toBe(40);
    expect(floorSeconds('B2', 5)).toBe(6 * 40);
    expect(floorSeconds('level 3', 1)).toBe(80);
    expect(floorSeconds('L1', 1.5)).toBe(20);
  });
  it('unknown floor: 20 s per floor away from the ground (L1)', () => {
    expect(SECONDS_PER_FLOOR_FROM_GROUND).toBe(20);
    expect(floorSeconds(undefined, 1)).toBe(0);
    expect(floorSeconds(null, 0)).toBe(0);
    expect(floorSeconds(undefined, -1)).toBe(20);
    expect(floorSeconds(undefined, 4)).toBe(60);
    // Something that isn't a floor counts as unknown.
    expect(floorSeconds('Concourse', -2)).toBe(40);
  });
  it('nothing when the toilet floor is unknown', () => {
    expect(floorSeconds('B1', null)).toBe(0);
    expect(floorSeconds(undefined, null)).toBe(0);
  });
});

describe('secondsAsStraightM', () => {
  it('inverts estimateWalkSeconds', () => {
    expect(estimateWalkSeconds(secondsAsStraightM(40))).toBe(40);
  });
});

describe('floorReason', () => {
  it('says how many floors and which way', () => {
    expect(floorReason('B1', -1)).toBe('On your level');
    expect(floorReason('B1', 1)).toBe('1 floor up');
    expect(floorReason('L3', -2)).toBe('4 floors down');
    expect(floorReason('L1', 1.5)).toBe('Half a floor up');
    expect(floorReason(undefined, 3)).toBeNull();
    expect(floorReason('L2', null)).toBeNull();
  });
});

describe('ranking with floors', () => {
  // Two toilets in one mall at the same spot.
  const b2 = (user?: string) => cand({ id: 'b2', distanceM: 40, floorSeconds: floorSeconds(user, -2) });
  const l5 = (user?: string) => cand({ id: 'l5', distanceM: 40, floorSeconds: floorSeconds(user, 5) });

  it('the toilet on your floor wins, calm and urgent', () => {
    for (const w of [DEFAULT_WEIGHTS, URGENT_WEIGHTS]) {
      expect(rank([b2('L5'), l5('L5')], 1500, w, now)[0].candidate.id).toBe('l5');
      expect(rank([b2('B2'), l5('B2')], 1500, w, now)[0].candidate.id).toBe('b2');
    }
  });

  it('unknown floor: nearer the ground wins', () => {
    expect(rank([b2(), l5()], 1500, DEFAULT_WEIGHTS, now)[0].candidate.id).toBe('b2');
  });

  it('a floor costs about as much as walking the same time', () => {
    // 4 floors (160 s) vs 150 m more of walking (156 s): close, and the floors lose by a little.
    const up = cand({ id: 'up', distanceM: 10, floorSeconds: 4 * SECONDS_PER_FLOOR });
    const walk = cand({ id: 'walk', distanceM: 160 });
    expect(rank([up, walk], 1500, URGENT_WEIGHTS, now)[0].candidate.id).toBe('walk');
  });

  it('a toilet with no known floor is not penalised', () => {
    expect(rank([cand({ id: 'unknown', distanceM: 40 }), l5()], 1500, DEFAULT_WEIGHTS, now)[0].candidate.id).toBe(
      'unknown',
    );
  });

  it('urgent re-sort by minutes keeps the ground preference', () => {
    const items = [
      { id: 'l6', walkSeconds: 60, score: 90 },
      { id: 'l1', walkSeconds: 70, score: 80 },
    ];
    const extra: Record<string, number> = { l6: 100, l1: 0 };
    expect(byWalkMinutes(items).map((i) => i.id)).toEqual(['l6', 'l1']);
    expect(byWalkMinutes(items, (i) => extra[i.id]!).map((i) => i.id)).toEqual(['l1', 'l6']);
  });
});
