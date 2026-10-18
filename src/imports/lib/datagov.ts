import fs from 'node:fs';
import { politeFetch, type CacheMode } from './http.js';
import { ensureDir, readJson, writeText } from './files.js';
import path from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Download a data.gov.sg dataset file through
 * `https://api-open.data.gov.sg/v1/public/api/datasets/<id>/poll-download`, which returns a
 * short-lived signed S3 URL. The anonymous API is rate limited (code 24 "TOO_MANY_REQUESTS" ->
 * wait ~10 s), so we back off generously.
 */
export async function downloadDatagov(datasetId: string): Promise<string> {
  const pollUrl = `https://api-open.data.gov.sg/v1/public/api/datasets/${datasetId}/poll-download`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await politeFetch(pollUrl, { minIntervalMs: 1500, retries: 2 });
    const body = (await res.json().catch(() => ({}))) as { code?: number; data?: { url?: string; status?: string }; errorMsg?: string };
    const url = body.data?.url;
    if (url) {
      const file = await politeFetch(url, { minIntervalMs: 0, timeoutMs: 120_000 });
      if (!file.ok) throw new Error(`data.gov.sg ${datasetId}: file HTTP ${file.status}`);
      return await file.text();
    }
    if (body.code === 24 || res.status === 429 || body.data?.status === 'PENDING' || body.data?.status === 'IN_PROGRESS') {
      await sleep(11_000 + attempt * 2000);
      continue;
    }
    throw new Error(`data.gov.sg ${datasetId}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  throw new Error(`data.gov.sg ${datasetId}: still rate limited after retries`);
}

/** Cached download to `file` (committed under data/raw/datagov/). Returns parsed JSON. */
export async function cachedDatagovGeojson<T = unknown>(datasetId: string, file: string, mode: CacheMode = {}): Promise<T> {
  if (!mode.refresh && fs.existsSync(file)) return readJson<T>(file);
  if (mode.offline) throw new Error(`Offline and no cached file ${file}`);
  const text = await downloadDatagov(datasetId);
  const json = JSON.parse(text) as T;
  ensureDir(path.dirname(file));
  writeText(file, JSON.stringify(json) + '\n');
  return json;
}

/** data.gov.sg KML-derived GeoJSON puts attributes in an HTML table in `Description`. */
export function parseDescriptionTable(html: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!html) return out;
  const re = /<th>\s*([^<]*?)\s*<\/th>\s*<td>\s*([\s\S]*?)\s*<\/td>/gi;
  for (const m of html.matchAll(re)) out[m[1]!.trim()] = decodeEntities(m[2]!.trim());
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Flat attribute bag: properties merged with any Description-table attributes. */
export function featureAttributes(props: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props ?? {})) if (v !== null && v !== undefined && typeof v !== 'object') out[k] = String(v);
  Object.assign(out, parseDescriptionTable(typeof props?.['Description'] === 'string' ? (props['Description'] as string) : null));
  return out;
}

export const DATAGOV_IDS = {
  planningArea2019: 'd_4765db0e87b9c86336792efe8a1f7a66',
  hawker: 'd_4a086da0a5553be1d89383cd90d07ecd',
  mrtExits: 'd_b39d3a0871985372d7e1637193335da5',
  communityClubs: 'd_f706de1427279e61fe41e89e24d440fa',
  parks: 'd_0542d48f0991541706b58059381a6eca',
  libraries: 'd_27b8dae65d9ca1539e14d09578b17cbf',
} as const;
