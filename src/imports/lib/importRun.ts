import type { DataSource, PrismaClient } from '../../generated/prisma/client.js';
import type { Prisma } from '../../generated/prisma/client.js';
type InputJsonValue = Prisma.InputJsonValue;

export interface RunCounts {
  inserted: number;
  updated: number;
  skipped: number;
}

/**
 * Wraps an importer: creates an ImportRun row up front, then records counts + log JSON
 * (including any error) when it finishes.
 */
export async function withImportRun<T extends RunCounts & { log: Record<string, unknown> }>(
  db: PrismaClient,
  source: DataSource,
  command: string,
  body: () => Promise<T>,
): Promise<T> {
  const run = await db.importRun.create({ data: { source, command } });
  try {
    const result = await body();
    await db.importRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
        log: toJson(result.log),
      },
    });
    return result;
  } catch (err) {
    await db.importRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), log: toJson({ error: String((err as Error)?.stack ?? err) }) },
    });
    throw err;
  }
}

export function toJson(v: unknown): InputJsonValue {
  return JSON.parse(JSON.stringify(v ?? null)) as InputJsonValue;
}

export function counter() {
  return { inserted: 0, updated: 0, skipped: 0 };
}
