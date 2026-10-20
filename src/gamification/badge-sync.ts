import type { PrismaClient } from '../generated/prisma/client.js';
import { BADGES } from './badges.js';

/**
 * Upserts every BADGES definition into the Badge table (rows must exist before any UserBadge
 * insert). Idempotent: one transaction of upserts keyed on the badge id. Returns the badge count.
 *
 * Where it runs:
 * - Vercel: at deploy time, `pnpm vercel-build` -> `node dist/sync-badges.js`, right after the
 *   migrations, so a cold start never touches the database (a probe on /health/live must not wake Neon).
 * - Locally, CI and e2e: GamificationService.onApplicationBootstrap, plus `pnpm db:seed` and
 *   `pnpm db:sync-badges`.
 */
export async function syncBadges(db: Pick<PrismaClient, '$transaction' | 'badge'>): Promise<number> {
  await db.$transaction(
    BADGES.map((b) =>
      db.badge.upsert({
        where: { id: b.id },
        create: { id: b.id, name: b.name, description: b.description, icon: b.icon, rule: b.rule },
        update: { name: b.name, description: b.description, icon: b.icon, rule: b.rule },
      }),
    ),
  );
  return BADGES.length;
}

/** True on a Vercel deployment (build or runtime), where the build owns the badge sync. */
export function onVercel(source: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(source.VERCEL || source.VERCEL_ENV);
}
