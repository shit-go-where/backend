/**
 * `pnpm db:seed` — offline seed: both 2024 fieldwork surveys (the March pilot, then the Aug-Oct
 * expanded survey) from the committed curated JSON (data/curated/*.json, plus enrichment.csv and
 * survey2-venue-matches.json), then score recompute. No network.
 * For the full pipeline (OSM, data.gov.sg, Wikidata) run `pnpm cli all`. See data/README.md.
 */
import { runEnrichCheck } from '../src/imports/enrich.js';
import { closeDb, getDb } from '../src/imports/lib/db.js';
import { withImportRun } from '../src/imports/lib/importRun.js';
import { seedFieldwork } from '../src/imports/seed/fieldwork.js';
import { seedFieldwork2024b } from '../src/imports/seed/fieldwork2024b.js';
import { recomputeAllScores } from '../src/toilets/scoring.js';
import { syncBadges } from '../src/gamification/badge-sync.js';

async function main() {
  const db = getDb();
  runEnrichCheck();
  await withImportRun(db, 'FIELDWORK_2024', 'db:seed', () => seedFieldwork(db));
  // After the pilot: men's rows of the expanded survey attach to pilot toilets.
  await withImportRun(db, 'FIELDWORK_2024_EXPANDED', 'db:seed', () => seedFieldwork2024b(db));
  const n = await recomputeAllScores(db);
  console.log(`Recomputed scores for ${n} toilets`);
  console.log(`Synced ${await syncBadges(db)} badges`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
