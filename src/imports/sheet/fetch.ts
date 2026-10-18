import path from 'node:path';
import { politeFetch } from '../lib/http.js';
import { writeText } from '../lib/files.js';
import { paths } from '../lib/paths.js';

export const SHEET_ID = '1nMJffy4cIbJwKaiI--LgnsdksrTStu-bGiybAxtYqww';

/**
 * Tabs and their gids (read from the sheet's /htmlview). We use the per-gid CSV export rather
 * than gviz: gviz collapses the two header rows into one ("Toiletries (5) Toilet Paper (1)"),
 * while the export keeps both rows exactly as laid out in the sheet.
 */
export const SHEET_TABS = [
  { name: 'Rubrics', gid: '0', file: 'rubrics.csv' },
  { name: 'General Data', gid: '1534707311', file: 'general-data.csv' },
  { name: 'RAS Ratings', gid: '1650716793', file: 'ras-ratings.csv' },
  { name: 'Toilet Renewal', gid: '812045906', file: 'toilet-renewal.csv' },
  { name: 'Miscellaneous ', gid: '2088377781', file: 'miscellaneous.csv' },
] as const;

export function sheetTabPath(file: string): string {
  return path.join(paths.sheetRawDir, file);
}

export async function fetchSheet(): Promise<{ log: Record<string, unknown> }> {
  const log: Record<string, unknown> = {};
  for (const tab of SHEET_TABS) {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${tab.gid}`;
    const res = await politeFetch(url, { redirect: 'follow', minIntervalMs: 500 });
    if (!res.ok) throw new Error(`Sheet tab "${tab.name}" HTTP ${res.status}`);
    const text = (await res.text()).replace(/\r\n/g, '\n');
    if (text.trimStart().startsWith('<')) throw new Error(`Sheet tab "${tab.name}" returned HTML (not public?)`);
    const changed = writeText(sheetTabPath(tab.file), text.endsWith('\n') ? text : text + '\n');
    const rows = text.split('\n').length;
    log[tab.name] = { file: `data/raw/sheet/${tab.file}`, rows, changed };
    console.log(`  ${tab.name.padEnd(16)} -> data/raw/sheet/${tab.file} (${rows} lines${changed ? ', changed' : ''})`);
  }
  return { log };
}
