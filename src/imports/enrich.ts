import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { loadFieldwork, type FeatureName } from './curated/schema.js';
import { writeText } from './lib/files.js';
import { paths } from './lib/paths.js';

export const ENRICHMENT_HEADER = [
  'sourceKey',
  'areaType',
  'level',
  'nearestExit',
  'male',
  'female',
  'accessible',
  'sitting',
  'squat',
  'babyChange',
  'notes',
] as const;

const FEATURE_COLUMNS: Record<string, FeatureName> = {
  male: 'MALE',
  female: 'FEMALE',
  accessible: 'ACCESSIBLE',
  sitting: 'SITTING',
  squat: 'SQUAT',
  babyChange: 'BABY_CHANGE',
};

const bool = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.enum(['', 'y', 'yes', 'true', '1', 'n', 'no', 'false', '0']))
  .transform((s) => (s === '' ? undefined : ['y', 'yes', 'true', '1'].includes(s)));
const opt = z
  .string()
  .transform((s) => s.trim())
  .transform((s) => (s === '' ? undefined : s));

const RowSchema = z.object({
  sourceKey: z.string().trim().min(1),
  areaType: z
    .string()
    .transform((s) => s.trim().toUpperCase())
    .pipe(z.enum(['', 'PAID_AREA', 'UNPAID_AREA', 'NOT_APPLICABLE', 'UNKNOWN']))
    .transform((s) => (s === '' ? undefined : s)),
  level: opt,
  nearestExit: opt,
  male: bool,
  female: bool,
  accessible: bool,
  sitting: bool,
  squat: bool,
  babyChange: bool,
  notes: opt,
});

export interface Enrichment {
  sourceKey: string;
  areaType?: 'PAID_AREA' | 'UNPAID_AREA' | 'NOT_APPLICABLE' | 'UNKNOWN';
  level?: string;
  nearestExit?: string;
  notes?: string;
  features: { feature: FeatureName; present: boolean }[];
}

/** Read data/curated/enrichment.csv (created with just the header if missing). Throws on invalid rows. */
export function loadEnrichment(file = paths.enrichment): Enrichment[] {
  if (!fs.existsSync(file)) {
    writeText(file, ENRICHMENT_HEADER.join(',') + '\n');
    return [];
  }
  const records = parse(fs.readFileSync(file, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: false,
  }) as Record<string, string>[];
  const out: Enrichment[] = [];
  const seen = new Set<string>();
  records.forEach((rec, i) => {
    const full = Object.fromEntries(ENRICHMENT_HEADER.map((h) => [h, rec[h] ?? '']));
    const parsed = RowSchema.safeParse(full);
    if (!parsed.success) throw new Error(`enrichment.csv row ${i + 2}: ${parsed.error.message}`);
    const r = parsed.data;
    if (seen.has(r.sourceKey)) throw new Error(`enrichment.csv row ${i + 2}: duplicate sourceKey ${r.sourceKey}`);
    seen.add(r.sourceKey);
    const features: Enrichment['features'] = [];
    for (const [col, feature] of Object.entries(FEATURE_COLUMNS)) {
      const v = r[col as keyof typeof r];
      if (typeof v === 'boolean') features.push({ feature, present: v });
    }
    out.push({
      sourceKey: r.sourceKey,
      ...(r.areaType ? { areaType: r.areaType } : {}),
      ...(r.level ? { level: r.level } : {}),
      ...(r.nearestExit ? { nearestExit: r.nearestExit } : {}),
      ...(r.notes ? { notes: r.notes } : {}),
      features,
    });
  });
  return out;
}

/** `enrich` command: validate the CSV against the curated toilets. Applied by seed:fieldwork. */
export function runEnrichCheck(): { log: Record<string, unknown> } {
  const rows = loadEnrichment();
  const fieldwork = loadFieldwork();
  const known = new Set(fieldwork.toilets.map((t) => t.sourceKey));
  const unknown = rows.filter((r) => r.sourceKey.startsWith('sheet:') && !known.has(r.sourceKey)).map((r) => r.sourceKey);
  if (unknown.length) throw new Error(`enrichment.csv references unknown fieldwork toilets: ${unknown.join(', ')}`);
  console.log(`  enrichment.csv: ${rows.length} row(s) valid; applied with source ADMIN by seed:fieldwork`);
  return { log: { rows: rows.length } };
}
