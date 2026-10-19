import { buildLineBoard, lineName, type StationForBoard } from './lines.js';

const st = (lines: string[], bestScore: number | null, extra: Partial<StationForBoard> = {}): StationForBoard => ({
  lines,
  bestScore,
  trustedToilets: 0,
  freshToilets: 0,
  checkInsWeek: 0,
  hasToilets: bestScore !== null,
  ...extra,
});

describe('line board', () => {
  it('names known lines and passes unknown codes through', () => {
    expect(lineName('CCL')).toBe('Circle Line');
    expect(lineName('XYZ')).toBe('XYZ');
  });

  it('counts an interchange for every line, ranks by average score, unscored last', () => {
    const board = buildLineBoard([
      st(['NSL', 'CCL'], 8, { trustedToilets: 2, freshToilets: 1, checkInsWeek: 3 }),
      st(['NSL'], 6, { trustedToilets: 1, freshToilets: 1 }),
      st(['CCL'], null),
      st(['TEL'], null),
      st(['EWL'], 9),
    ]);
    expect(board.map((r) => [r.rank, r.code, r.avgScore])).toEqual([
      [1, 'EWL', 9],
      [2, 'CCL', 8],
      [3, 'NSL', 7],
      [4, 'TEL', null],
    ]);
    const nsl = board.find((r) => r.code === 'NSL')!;
    expect(nsl).toMatchObject({ stations: 2, stationsWithToilets: 2, scoredStations: 2, freshPct: 66.7, checkInsWeek: 3 });
    const ccl = board.find((r) => r.code === 'CCL')!;
    expect(ccl).toMatchObject({ stations: 2, stationsWithToilets: 1, scoredStations: 1, freshPct: 50 });
    expect(board.find((r) => r.code === 'TEL')!.freshPct).toBeNull();
  });

  it('ties share a rank and keep line order', () => {
    const board = buildLineBoard([st(['DTL'], 7), st(['NSL'], 7), st(['EWL'], 5)]);
    expect(board.map((r) => [r.rank, r.code])).toEqual([
      [1, 'NSL'],
      [1, 'DTL'],
      [3, 'EWL'],
    ]);
  });

  it('a station listing a line twice counts once', () => {
    expect(buildLineBoard([st(['NSL', 'NSL'], 5)])[0].stations).toBe(1);
  });
});
