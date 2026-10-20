/**
 * levels:backfill normalises community and curated rows and leaves OSM rows to import:osm, whose
 * stored levels may still be in OSM's numbering ("0" for the ground floor).
 */
import { backfillLevels } from './levels.js';

interface Row {
  id: string;
  level: string | null;
  levelOrder: number | null;
  source: string;
}

function db(rows: Row[]) {
  const updates: { id: string; data: { level: string | null; levelOrder: number | null } }[] = [];
  const matches = (r: Row, where?: { source?: { not?: string } | string }) => {
    const s = where?.source;
    if (s === undefined) return true;
    return typeof s === 'string' ? r.source === s : r.source !== s.not;
  };
  const stub = {
    toilet: {
      findMany: async ({ where }: { where?: { source?: { not?: string } } }) =>
        rows.filter((r) => matches(r, where)).map(({ id, level, levelOrder }) => ({ id, level, levelOrder })),
      count: async ({ where }: { where?: { source?: string } }) => rows.filter((r) => matches(r, where)).length,
      update: (u: { where: { id: string }; data: { level: string | null; levelOrder: number | null } }) => {
        updates.push({ id: u.where.id, data: u.data });
        return u;
      },
    },
    $transaction: async (ops: unknown[]) => ops,
  };
  return { stub: stub as never, updates };
}

describe('backfillLevels', () => {
  const rows: Row[] = [
    { id: 'osm-1', level: '1', levelOrder: null, source: 'OSM' },
    { id: 'osm-2', level: '0;1', levelOrder: null, source: 'OSM' },
    { id: 'community', level: 'level 3', levelOrder: null, source: 'COMMUNITY' },
    { id: 'fieldwork', level: 'B1', levelOrder: -1, source: 'FIELDWORK_2024' },
  ];

  it('normalises a community row and skips OSM rows', async () => {
    const { stub, updates } = db(rows);
    const r = await backfillLevels(stub);
    expect(r).toEqual({ scanned: 2, changed: 1, skippedOsm: 2 });
    expect(updates).toEqual([{ id: 'community', data: { level: 'L3', levelOrder: 3 } }]);
  });

  it('--dry-run writes nothing', async () => {
    const { stub, updates } = db(rows);
    const r = await backfillLevels(stub, { dryRun: true });
    expect(r.changed).toBe(1);
    expect(updates).toEqual([]);
  });
});
