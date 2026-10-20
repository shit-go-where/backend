/**
 * Deploy-time badge sync: `node dist/sync-badges.js` (end of `pnpm vercel-build`) or
 * `pnpm db:sync-badges` locally. Uses the migration connection (DIRECT_URL, then
 * DATABASE_URL_UNPOOLED, then DATABASE_URL) and needs no other app env. See gamification/badge-sync.ts.
 */
import { closeDb, getDb } from './imports/lib/db.js';
import { syncBadges } from './gamification/badge-sync.js';

async function main() {
  const n = await syncBadges(getDb());
  console.log(`Synced ${n} badges`);
}

main()
  .catch((err: unknown) => {
    console.error('Badge sync failed', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
