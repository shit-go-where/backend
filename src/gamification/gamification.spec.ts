import { BADGES, earnedBadgeIds, type BadgeStats } from './badges.js';
import { rankWithTies } from './ranking.js';
import { longestSgtDayStreak, sgtDayKey, sgtDayStart, sgtHour } from './sgt.js';

describe('SGT day bucketing', () => {
  it('rolls the day over at 16:00 UTC', () => {
    expect(sgtDayKey(new Date('2026-10-18T15:59:59Z'))).toBe('2026-10-18');
    expect(sgtDayKey(new Date('2026-10-18T16:00:00Z'))).toBe('2026-10-19');
  });

  it('computes the UTC instant of SGT midnight', () => {
    expect(sgtDayStart(new Date('2026-10-18T03:00:00Z')).toISOString()).toBe('2026-10-17T16:00:00.000Z');
    expect(sgtDayStart(new Date('2026-10-18T17:00:00Z')).toISOString()).toBe('2026-10-18T16:00:00.000Z');
  });

  it('reports SGT hours', () => {
    expect(sgtHour(new Date('2026-10-18T17:30:00Z'))).toBe(1);
    expect(sgtHour(new Date('2026-10-18T00:00:00Z'))).toBe(8);
  });

  it('finds the longest streak of consecutive SGT days', () => {
    const d = (s: string) => new Date(s);
    expect(longestSgtDayStreak([])).toBe(0);
    expect(
      longestSgtDayStreak([
        d('2026-10-01T02:00:00Z'),
        d('2026-10-01T10:00:00Z'), // same SGT day
        d('2026-10-01T17:00:00Z'), // next SGT day (Oct 2, 01:00)
        d('2026-10-03T05:00:00Z'),
        d('2026-10-05T05:00:00Z'),
      ]),
    ).toBe(3);
  });
});

describe('badge evaluator', () => {
  const base: BadgeStats = {
    checkIns: [],
    lineStations: {},
    approvedSubmissions: 0,
    reviews: 0,
    approvedPhotos: 0,
    role: 'USER',
  };
  const ci = (toiletId: string, venueId: string, at = '2026-10-18T04:00:00Z') => ({
    toiletId,
    venueId,
    createdAt: new Date(at),
  });

  it('has unique ids and an emoji icon', () => {
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(BADGES.length);
    expect(BADGES.length).toBeGreaterThanOrEqual(12);
  });

  it('earns nothing with no activity', () => {
    expect(earnedBadgeIds(base)).toEqual([]);
  });

  it('awards first-flush and night-owl', () => {
    const ids = earnedBadgeIds({ ...base, checkIns: [ci('t1', 'v1', '2026-10-18T18:30:00Z')] });
    expect(ids).toContain('first-flush');
    expect(ids).toContain('night-owl');
    expect(ids).not.toContain('regular');
  });

  it('awards regular but not explorer for 10 check-ins at one toilet', () => {
    const ids = earnedBadgeIds({ ...base, checkIns: Array.from({ length: 10 }, () => ci('t1', 'v1')) });
    expect(ids).toContain('regular');
    expect(ids).not.toContain('explorer');
    expect(ids).not.toContain('night-owl');
  });

  it('awards a line collector only when every station on the line is stamped', () => {
    const stats = { ...base, lineStations: { CCL: ['a', 'b'], NSL: [] }, checkIns: [ci('t1', 'a')] };
    expect(earnedBadgeIds(stats)).not.toContain('line-ccl');
    const done = { ...stats, checkIns: [ci('t1', 'a'), ci('t2', 'b')] };
    expect(earnedBadgeIds(done)).toContain('line-ccl');
    expect(earnedBadgeIds(done)).not.toContain('line-nsl'); // empty line never completes
  });

  it('awards contribution and role badges', () => {
    const ids = earnedBadgeIds({ ...base, approvedSubmissions: 10, reviews: 10, approvedPhotos: 5, role: 'MODERATOR' });
    expect(ids).toEqual(expect.arrayContaining(['first-contribution', 'cartographer', 'critic', 'shutterbug', 'trusted']));
  });

  it('awards streak-7 for seven consecutive SGT days', () => {
    const days = Array.from({ length: 7 }, (_, i) => ci('t1', 'v1', `2026-10-0${i + 1}T04:00:00Z`));
    expect(earnedBadgeIds({ ...base, checkIns: days })).toContain('streak-7');
    expect(earnedBadgeIds({ ...base, checkIns: days.slice(1) })).not.toContain('streak-7');
  });
});

describe('rankWithTies', () => {
  it('shares ranks on ties and skips after', () => {
    const ranked = rankWithTies([
      { h: 'a', points: 30 },
      { h: 'b', points: 20 },
      { h: 'c', points: 20 },
      { h: 'd', points: 10 },
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 2, 4]);
  });

  it('handles empty input', () => {
    expect(rankWithTies([])).toEqual([]);
  });
});
