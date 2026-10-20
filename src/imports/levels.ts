/**
 * One-off backfill for the level_order migration: rewrites every toilet's `level` to its normalised
 * form and fills `levelOrder` (src/common/level.ts). Safe to re-run; only rows that change are written.
 */
import type { PrismaClient } from '../generated/prisma/client.js';
import { levelFields } from '../common/level.js';

export interface LevelBackfillResult {
  scanned: number;
  changed: number;
}

export async function backfillLevels(db: PrismaClient, opts: { dryRun?: boolean } = {}): Promise<LevelBackfillResult> {
  const rows = await db.toilet.findMany({ select: { id: true, level: true, levelOrder: true } });
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
  return { scanned: rows.length, changed: changes.length };
}
