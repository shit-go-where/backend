import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** backend/ (this file lives in backend/src/imports/lib). */
export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DATA_DIR = path.join(BACKEND_ROOT, 'data');
export const RAW_DIR = path.join(DATA_DIR, 'raw');
export const CURATED_DIR = path.join(DATA_DIR, 'curated');

export const paths = {
  sheetRawDir: path.join(RAW_DIR, 'sheet'),
  survey2RawDir: path.join(RAW_DIR, 'survey-2024b'),
  geocodeCacheDir: path.join(RAW_DIR, 'geocode-cache'),
  osmRawDir: path.join(RAW_DIR, 'osm'),
  datagovRawDir: path.join(RAW_DIR, 'datagov'),
  wikidataRawDir: path.join(RAW_DIR, 'wikidata'),
  planningAreaGeojson: path.join(RAW_DIR, 'datagov', 'planning-area-2019.geojson'),
  fieldwork: path.join(CURATED_DIR, 'fieldwork-2024.json'),
  fieldwork2024b: path.join(CURATED_DIR, 'fieldwork-2024b.json'),
  survey2Matches: path.join(CURATED_DIR, 'survey2-venue-matches.json'),
  survey2Geocoded: path.join(CURATED_DIR, 'survey2-venues.geocoded.json'),
  review: path.join(CURATED_DIR, 'review.json'),
  geocoded: path.join(CURATED_DIR, 'venues.geocoded.json'),
  overrides: path.join(CURATED_DIR, 'overrides.json'),
  enrichment: path.join(CURATED_DIR, 'enrichment.csv'),
};
