import fs from 'node:fs';
import { readJson, writeJson } from './files.js';

export const USER_AGENT =
  'shit-go-where-importer/0.1 (Singapore toilet finder; student project; contact via repo)';

const lastRequestAt = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PoliteFetchOptions extends RequestInit {
  /** Minimum gap between requests to the same host (ms). Default 250 (= 4 req/s). */
  minIntervalMs?: number;
  retries?: number;
  timeoutMs?: number;
}

/** fetch() with per-host rate limiting, timeout and retries with exponential backoff. */
export async function politeFetch(url: string, opts: PoliteFetchOptions = {}): Promise<Response> {
  const { minIntervalMs = 250, retries = 4, timeoutMs = 60_000, ...init } = opts;
  const host = new URL(url).host;
  let attempt = 0;
  for (;;) {
    const wait = (lastRequestAt.get(host) ?? 0) + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt.set(host, Date.now());
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
        attempt++;
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(1000 * 2 ** attempt);
      attempt++;
    }
  }
}

/** GET JSON; retries (with backoff) when a server answers with an HTML rate-limit page instead of JSON. */
export async function fetchJson<T = unknown>(url: string, opts: PoliteFetchOptions = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await politeFetch(url, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      if (attempt >= 4) throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 120)}`);
      await sleep(2000 * 2 ** attempt);
    }
  }
}

export interface CacheMode {
  /** Ignore the cache and re-download. */
  refresh?: boolean;
  /** Never touch the network; throw if the cache is missing. */
  offline?: boolean;
}

/** Read `file` if cached, else run `load` and cache its JSON result. */
export async function cachedJson<T>(file: string, load: () => Promise<T>, mode: CacheMode = {}): Promise<T> {
  if (!mode.refresh && fs.existsSync(file)) return readJson<T>(file);
  if (mode.offline) throw new Error(`Offline and no cache at ${file}`);
  const value = await load();
  writeJson(file, value);
  return value;
}
