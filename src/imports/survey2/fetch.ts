import path from 'node:path';
import { politeFetch } from '../lib/http.js';
import { writeText } from '../lib/files.js';
import { paths } from '../lib/paths.js';

/** The expanded Aug-Oct 2024 survey (u/eggmayosandwich and team). */
export const SURVEY2_SHEET_ID = '1cVrz3bFkSYFpEdSGu4v2aJ03lF8WyklCd1e50U2A6ts';

/**
 * The two tabs we import and their gids (read from the sheet's /htmlview). Every other tab
 * ("Processed Data", "Combined/ Male", ...) is derived from these two and ignored.
 */
export const SURVEY2_TABS = [
  { name: 'Raw Data', gid: '1020801738', file: 'raw-data.csv' },
  { name: 'Location Code Index', gid: '1448365931', file: 'location-index.csv' },
] as const;

export function survey2TabPath(file: string): string {
  return path.join(paths.survey2RawDir, file);
}

export async function fetchSurvey2(): Promise<{ log: Record<string, unknown> }> {
  const log: Record<string, unknown> = {};
  for (const tab of SURVEY2_TABS) {
    const url = `https://docs.google.com/spreadsheets/d/${SURVEY2_SHEET_ID}/export?format=csv&gid=${tab.gid}`;
    const res = await politeFetch(url, { redirect: 'follow', minIntervalMs: 500 });
    if (!res.ok) throw new Error(`Sheet tab "${tab.name}" HTTP ${res.status}`);
    const text = (await res.text()).replace(/\r\n/g, '\n');
    if (text.trimStart().startsWith('<')) throw new Error(`Sheet tab "${tab.name}" returned HTML (not public?)`);
    const changed = writeText(survey2TabPath(tab.file), text.endsWith('\n') ? text : text + '\n');
    const rows = text.split('\n').length;
    log[tab.name] = { file: `data/raw/survey-2024b/${tab.file}`, rows, changed };
    console.log(`  ${tab.name.padEnd(20)} -> data/raw/survey-2024b/${tab.file} (${rows} lines${changed ? ', changed' : ''})`);
  }
  return { log };
}
