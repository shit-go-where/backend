/**
 * One-off backfill for the level_order migration: rewrites every toilet's `level` to its normalised
 * form and fills `levelOrder` (src/common/level.ts). Safe to re-run; only rows that change are written.
 *
 * OSM rows are skipped. The importer used to store OSM's own numbering ("0" for the ground floor,
 * "0;1"), which reads one floor low as a Singapore level; `import:osm` rewrites those rows from
 * their tags (osm/tags.ts levelOf), so run it after this.
 */
import type { PrismaClient } from '../generated/prisma/client.js';
import { DataSource } from '../generated/prisma/enums.js';
import { levelFields } from '../common/level.js';

export interface LevelBackfillResult {
  scanned: number;
  changed: number;
  /** OSM toilets left for import:osm. */
  skippedOsm: number;
}

type Db = Pick<PrismaClient, 'toilet' | '$transaction'>;

export async function backfillLevels(db: Db, opts: { dryRun?: boolean } = {}): Promise<LevelBackfillResult> {
  const [rows, skippedOsm] = await Promise.all([
    db.toilet.findMany({
      where: { source: { not: DataSource.OSM } },
      select: { id: true, level: true, levelOrder: true },
    }),
    db.toilet.count({ where: { source: DataSource.OSM } }),
  ]);
  const changes = rows
    .map((r) => ({ id: r.id, before: r.level, ...levelFields(r.level), orderBefore: r.levelOrder }))
    .filter((r) => r.level !== r.before || r.levelOrder !== r.orderBefore);
  for (const c of changes.slice(0, 20)) {
    if (c.level !== c.before) console.log(`  ${c.id}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.level)}`);
  }
  if (!opts.dryRun) {
    // Small batches in one transaction each: a few thousand rows at most.
    for (let i = 0; i < changes.length; i += 200) {
      await db.$transaction(
        changes
          .slice(i, i + 200)
          .map((c) => db.toilet.update({ where: { id: c.id }, data: { level: c.level, levelOrder: c.levelOrder } })),
      );
    }
  }
  return { scanned: rows.length, changed: changes.length, skippedOsm };
}
