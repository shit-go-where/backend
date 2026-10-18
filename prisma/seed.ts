/**
 * `pnpm db:seed` — offline seed: fieldwork venues/toilets/features/surveys from the committed
 * curated JSON (data/curated/*.json, plus enrichment.csv), then score recompute. No network.
 * For the full pipeline (OSM, data.gov.sg, Wikidata) run `pnpm cli all`. See data/README.md.
 */
import { runEnrichCheck } from '../src/imports/enrich.js';
import { closeDb, getDb } from '../src/imports/lib/db.js';
import { withImportRun } from '../src/imports/lib/importRun.js';
import { seedFieldwork } from '../src/imports/seed/fieldwork.js';
import { recomputeAllScores } from '../src/toilets/scoring.js';

async function main() {
  const db = getDb();
  runEnrichCheck();
  await withImportRun(db, 'FIELDWORK_2024', 'db:seed', () => seedFieldwork(db));
  const n = await recomputeAllScores(db);
  console.log(`Recomputed scores for ${n} toilets`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
