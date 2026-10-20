import { flagBool, flagStr, type ParsedArgs } from './lib/argv.js';
import { getDb } from './lib/db.js';
import { withImportRun } from './lib/importRun.js';
import { fetchSheet } from './sheet/fetch.js';
import { runNormalise } from './sheet/normalise.js';
import { runGeocode } from './geocode/geocode.js';
import { runEnrichCheck } from './enrich.js';
import { seedFieldwork } from './seed/fieldwork.js';
import { importOsm } from './osm/import.js';
import { importDatagov, DATAGOV_DATASET_NAMES, type DatagovDatasetName } from './datagov/import.js';
import { importWikidata } from './wikidata/import.js';
import { recomputeAllScores } from '../toilets/scoring.js';
import { backfillLevels } from './levels.js';

export interface Command {
  description: string;
  run(args: ParsedArgs): Promise<void>;
}

/**
 * Cache policy. Source imports (osm/datagov/wikidata) re-download by default — that is what the
 * scheduled jobs want — unless --offline or --cached (use the committed data/raw files).
 * geocode only calls OneMap for queries not in data/raw/geocode-cache unless --refresh.
 */
const cacheMode = (args: ParsedArgs) => ({ refresh: flagBool(args.flags, 'refresh'), offline: flagBool(args.flags, 'offline') });
const importMode = (args: ParsedArgs) => {
  const offline = flagBool(args.flags, 'offline');
  const cached = flagBool(args.flags, 'cached');
  return { offline, refresh: flagBool(args.flags, 'refresh') || (!offline && !cached) };
};

async function recompute(): Promise<void> {
  const db = getDb();
  const t0 = Date.now();
  const n = await recomputeAllScores(db);
  console.log(`  recomputed scores for ${n} toilets in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

export const COMMANDS: Record<string, Command> = {
  'sheet:fetch': {
    description: 'Download the fieldwork Google Sheet tabs to data/raw/sheet/*.csv',
    run: async () => {
      await fetchSheet();
    },
  },
  'sheet:normalise': {
    description: 'Raw sheet CSVs -> data/curated/fieldwork-2024.json (+ review.json)',
    run: async () => {
      runNormalise();
    },
  },
  geocode: {
    description: 'Geocode curated venues (OneMap, Wikidata fallback, overrides.json) + planning areas. --refresh, --offline',
    run: async (args) => {
      await runGeocode(cacheMode(args));
    },
  },
  enrich: {
    description: 'Validate data/curated/enrichment.csv (applied with source ADMIN by seed:fieldwork)',
    run: async () => {
      runEnrichCheck();
    },
  },
  'seed:fieldwork': {
    description: 'Upsert curated fieldwork venues/toilets/features/surveys into the DB, then recompute scores',
    run: async () => {
      const db = getDb();
      await withImportRun(db, 'FIELDWORK_2024', 'seed:fieldwork', () => seedFieldwork(db));
      await recompute();
    },
  },
  'import:osm': {
    description: 'Import OpenStreetMap toilets via Overpass. --cached/--offline (use data/raw/osm), --no-close',
    run: async (args) => {
      const db = getDb();
      await withImportRun(db, 'OSM', 'import:osm', () =>
        importOsm(db, { ...importMode(args), close: args.flags['close'] !== false }),
      );
    },
  },
  'import:datagov': {
    description: `Import data.gov.sg datasets. --dataset ${DATAGOV_DATASET_NAMES.join('|')}|all. --cached/--offline`,
    run: async (args) => {
      const ds = flagStr(args.flags, 'dataset') ?? args.positionals[0] ?? 'all';
      const names: DatagovDatasetName[] =
        ds === 'all' ? [...DATAGOV_DATASET_NAMES] : (ds.split(',') as DatagovDatasetName[]);
      for (const n of names) if (!DATAGOV_DATASET_NAMES.includes(n)) throw new Error(`Unknown dataset "${n}"`);
      const db = getDb();
      await withImportRun(db, 'DATAGOV', `import:datagov --dataset ${ds}`, () => importDatagov(db, names, importMode(args)));
    },
  },
  'import:wikidata': {
    description: 'Add MRT/LRT stations from Wikidata that are not in the DB yet. --cached/--offline',
    run: async (args) => {
      const db = getDb();
      await withImportRun(db, 'WIKIDATA', 'import:wikidata', () => importWikidata(db, importMode(args)));
    },
  },
  'recompute-scores': {
    description: 'Recompute Toilet.scoreCleanliness / reviewCount for every toilet',
    run: recompute,
  },
  'levels:backfill': {
    description:
      'Normalise every non-OSM Toilet.level ("level 3" -> "L3") and fill levelOrder (once, after the level_order migration; run import:osm after it). --dry-run',
    run: async (args) => {
      const dryRun = flagBool(args.flags, 'dry-run');
      const r = await backfillLevels(getDb(), { dryRun });
      console.log(`  ${r.changed} of ${r.scanned} toilets ${dryRun ? 'would change' : 'updated'}`);
      if (r.skippedOsm > 0) {
        console.log(`  ${r.skippedOsm} OSM toilets skipped: their levels use OSM numbering; run \`pnpm cli import:osm\` to rewrite them`);
      }
    },
  },
  all: {
    description:
      'Whole pipeline from committed raw files (pass --refresh to re-download sources, --offline to forbid network)',
    run: async (outer) => {
      const offline = flagBool(outer.flags, 'offline');
      // Reproducible by default: use data/raw/* unless --refresh.
      const args: ParsedArgs = { ...outer, flags: { ...outer.flags, cached: !flagBool(outer.flags, 'refresh') } };
      const steps: [string, ParsedArgs][] = [
        ['sheet:normalise', args],
        ['geocode', { ...args, flags: { ...args.flags, refresh: false } }],
        ['enrich', args],
        ['seed:fieldwork', args],
        ['import:osm', args],
        // Wikidata before data.gov so newly added stations also receive their LTA exits in one pass.
        ['import:wikidata', args],
        ['import:datagov', { ...args, flags: { ...args.flags, dataset: 'all' } }],
        ['recompute-scores', args],
      ];
      for (const [name, a] of steps) {
        console.log(`\n=== ${name}${offline ? ' (offline)' : ''}`);
        await COMMANDS[name]!.run(a);
      }
    },
  },
};
