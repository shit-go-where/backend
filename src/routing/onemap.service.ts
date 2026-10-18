import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { env } from '../config/env.js';
import type { LatLng } from '../common/geo.js';
import { decodePolyline } from './polyline.js';

const BASE = 'https://www.onemap.gov.sg';
const TIMEOUT_MS = 4000;
const TOKEN_KEY = 'onemap:token';
/** Refresh the token this long before it expires. */
const TOKEN_MARGIN_MS = 30 * 60_000;
const ROUTE_TTL_MS = 10 * 60_000;
const ROUTE_CACHE_MAX = 1000;

export interface WalkRoute {
  distanceM: number;
  durationS: number;
  polyline: [number, number][];
  source: 'onemap';
}

export interface GeoSearchResult {
  name: string;
  address: string;
  lat: number;
  lng: number;
}

type FetchFn = typeof fetch;

/**
 * OneMap client: search (no token), walking routes (token).
 * Every failure degrades to null / [] so callers can fall back to estimates. Never throws.
 */
@Injectable()
export class OneMapService {
  private readonly log = new Logger(OneMapService.name);
  private token: { value: string; expiresAt: number } | null = null;
  private tokenPending: Promise<string | null> | null = null;
  private readonly routes = new Map<string, { at: number; route: WalkRoute }>();
  /** Overridable in tests. */
  fetchFn: FetchFn = (...args) => fetch(...args);
  /** Overridable in tests. */
  credentials: { email: string; password: string } | null =
    env.ONEMAP_EMAIL && env.ONEMAP_PASSWORD
      ? { email: env.ONEMAP_EMAIL, password: env.ONEMAP_PASSWORD }
      : null;

  constructor(private readonly prisma: PrismaService) {}

  /** Credentials present, so routing can be attempted. */
  get routingConfigured(): boolean {
    return this.credentials !== null;
  }

  async search(q: string): Promise<GeoSearchResult[]> {
    const url = new URL(`${BASE}/api/common/elastic/search`);
    url.search = new URLSearchParams({
      searchVal: q,
      returnGeom: 'Y',
      getAddrDetails: 'Y',
      pageNum: '1',
    }).toString();
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        results?: Partial<Record<'SEARCHVAL' | 'BUILDING' | 'ADDRESS' | 'LATITUDE' | 'LONGITUDE', string>>[];
      };
      return (body.results ?? []).flatMap((r) => {
        const lat = Number(r.LATITUDE);
        const lng = Number(r.LONGITUDE);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
        return [
          {
            name: r.SEARCHVAL ?? r.BUILDING ?? '',
            address: r.ADDRESS ?? '',
            lat,
            lng,
          },
        ];
      });
    } catch (e) {
      this.log.warn(`OneMap search failed: ${(e as Error).message}`);
      return [];
    }
  }

  /** Walking route via OneMap, cached 10 min by rounded coordinates. null when unavailable. */
  async walk(from: LatLng, to: LatLng): Promise<WalkRoute | null> {
    if (!this.routingConfigured) return null;
    const key = [from.lat, from.lng, to.lat, to.lng].map((n) => n.toFixed(4)).join(',');
    const hit = this.routes.get(key);
    if (hit && Date.now() - hit.at < ROUTE_TTL_MS) return hit.route;

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken();
      if (!token) return null;
      try {
        const url = new URL(`${BASE}/api/public/routingsvc/route`);
        url.search = new URLSearchParams({
          start: `${from.lat},${from.lng}`,
          end: `${to.lat},${to.lng}`,
          routeType: 'walk',
        }).toString();
        const res = await this.fetchFn(url, {
          headers: { Authorization: token },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if ((res.status === 401 || res.status === 403) && attempt === 0) {
          await this.invalidateToken();
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          route_geometry?: string;
          route_summary?: { total_distance?: number; total_time?: number };
        };
        const distanceM = Number(body.route_summary?.total_distance);
        const durationS = Number(body.route_summary?.total_time);
        if (!body.route_geometry || !Number.isFinite(distanceM) || !Number.isFinite(durationS)) {
          throw new Error('Unexpected route response');
        }
        const route: WalkRoute = {
          distanceM: Math.round(distanceM),
          durationS: Math.round(durationS),
          polyline: decodePolyline(body.route_geometry),
          source: 'onemap',
        };
        this.remember(key, route);
        return route;
      } catch (e) {
        this.log.warn(`OneMap route failed: ${(e as Error).message}`);
        return null;
      }
    }
    return null;
  }

  private remember(key: string, route: WalkRoute) {
    if (this.routes.size >= ROUTE_CACHE_MAX) {
      const now = Date.now();
      for (const [k, v] of this.routes) if (now - v.at >= ROUTE_TTL_MS) this.routes.delete(k);
      if (this.routes.size >= ROUTE_CACHE_MAX) {
        const oldest = this.routes.keys().next().value;
        if (oldest !== undefined) this.routes.delete(oldest);
      }
    }
    this.routes.set(key, { at: Date.now(), route });
  }

  /** Token from memory, then the KeyValue table (shared by cold instances), then OneMap. */
  async getToken(): Promise<string | null> {
    if (!this.routingConfigured) return null;
    if (this.token && this.token.expiresAt - Date.now() > TOKEN_MARGIN_MS) return this.token.value;
    this.tokenPending ??= this.loadToken().finally(() => {
      this.tokenPending = null;
    });
    return this.tokenPending;
  }

  private async loadToken(): Promise<string | null> {
    try {
      const row = await this.prisma.keyValue.findUnique({ where: { key: TOKEN_KEY } });
      const stored = row?.value as { token?: unknown } | undefined;
      if (
        row?.expiresAt &&
        typeof stored?.token === 'string' &&
        row.expiresAt.getTime() - Date.now() > TOKEN_MARGIN_MS
      ) {
        this.token = { value: stored.token, expiresAt: row.expiresAt.getTime() };
        return stored.token;
      }
    } catch (e) {
      this.log.warn(`Token cache read failed: ${(e as Error).message}`);
    }
    try {
      const res = await this.fetchFn(`${BASE}/api/auth/post/getToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.credentials),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { access_token?: string; expiry_timestamp?: string | number };
      const expSec = Number(body.expiry_timestamp);
      if (!body.access_token || !Number.isFinite(expSec)) throw new Error('Unexpected token response');
      const expiresAt = new Date(expSec * 1000);
      this.token = { value: body.access_token, expiresAt: expiresAt.getTime() };
      await this.prisma.keyValue
        .upsert({
          where: { key: TOKEN_KEY },
          create: { key: TOKEN_KEY, value: { token: body.access_token }, expiresAt },
          update: { value: { token: body.access_token }, expiresAt },
        })
        .catch((e: Error) => this.log.warn(`Token cache write failed: ${e.message}`));
      return body.access_token;
    } catch (e) {
      this.log.warn(`OneMap token failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async invalidateToken() {
    this.token = null;
    await this.prisma.keyValue.deleteMany({ where: { key: TOKEN_KEY } }).catch(() => undefined);
  }
}
