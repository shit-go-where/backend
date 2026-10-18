/**
 * Standard competition ranking ("1224"): equal points share a rank, the next rank skips.
 * Input must already be sorted by points descending. Pure.
 */
export function rankWithTies<T extends { points: number }>(rows: T[]): (T & { rank: number })[] {
  let prevPoints: number | null = null;
  let prevRank = 0;
  return rows.map((row, i) => {
    const rank = prevPoints !== null && row.points === prevPoints ? prevRank : i + 1;
    prevPoints = row.points;
    prevRank = rank;
    return { ...row, rank };
  });
}
