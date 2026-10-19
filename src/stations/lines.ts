/** MRT and LRT lines as stored on Venue.lines, with display names. Pure. */

export const LINE_NAMES: Record<string, string> = {
  NSL: 'North-South Line',
  EWL: 'East-West Line',
  NEL: 'North East Line',
  CCL: 'Circle Line',
  DTL: 'Downtown Line',
  TEL: 'Thomson-East Coast Line',
  BPLRT: 'Bukit Panjang LRT',
  SKLRT: 'Sengkang LRT',
  PGLRT: 'Punggol LRT',
};

/** Board order when two lines tie: MRT before LRT, in the order above. */
const LINE_ORDER = Object.keys(LINE_NAMES);

export const lineName = (code: string) => LINE_NAMES[code] ?? code;

export interface StationForBoard {
  lines: string[];
  /** Best cleanliness score among the station's active toilets, or null if none is scored. */
  bestScore: number | null;
  /** Active Verified + Community toilets at the station. */
  trustedToilets: number;
  /** Of those, verified within the freshness window. */
  freshToilets: number;
  checkInsWeek: number;
  hasToilets: boolean;
}

export interface LineRow {
  rank: number;
  code: string;
  name: string;
  stations: number;
  stationsWithToilets: number;
  scoredStations: number;
  avgScore: number | null;
  freshPct: number | null;
  checkInsWeek: number;
}

/**
 * One row per line. An interchange counts for every line it serves (GROWTH.md G7). Ranked by
 * average station score, best first; lines with no scored station go last. Ties share a rank.
 */
export function buildLineBoard(stations: StationForBoard[]): LineRow[] {
  const acc = new Map<
    string,
    { stations: number; withToilets: number; scores: number[]; trusted: number; fresh: number; checkIns: number }
  >();
  for (const s of stations) {
    for (const code of new Set(s.lines)) {
      let a = acc.get(code);
      if (!a) acc.set(code, (a = { stations: 0, withToilets: 0, scores: [], trusted: 0, fresh: 0, checkIns: 0 }));
      a.stations++;
      if (s.hasToilets) a.withToilets++;
      if (s.bestScore !== null) a.scores.push(s.bestScore);
      a.trusted += s.trustedToilets;
      a.fresh += s.freshToilets;
      a.checkIns += s.checkInsWeek;
    }
  }
  const rows = [...acc.entries()].map(([code, a]) => ({
    code,
    name: lineName(code),
    stations: a.stations,
    stationsWithToilets: a.withToilets,
    scoredStations: a.scores.length,
    avgScore: a.scores.length ? Math.round((a.scores.reduce((x, y) => x + y, 0) / a.scores.length) * 10) / 10 : null,
    freshPct: a.trusted ? Math.round((a.fresh / a.trusted) * 1000) / 10 : null,
    checkInsWeek: a.checkIns,
  }));
  const orderOf = (c: string) => (LINE_ORDER.indexOf(c) === -1 ? LINE_ORDER.length : LINE_ORDER.indexOf(c));
  rows.sort(
    (x, y) =>
      Number(x.avgScore === null) - Number(y.avgScore === null) ||
      (y.avgScore ?? 0) - (x.avgScore ?? 0) ||
      orderOf(x.code) - orderOf(y.code),
  );
  let rank = 0;
  return rows.map((r, i) => {
    if (i === 0 || r.avgScore !== rows[i - 1].avgScore) rank = i + 1;
    return { rank, ...r };
  });
}
