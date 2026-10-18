import { OneMapService } from './onemap.service.js';
import { encodePolyline } from './polyline.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function fakePrisma() {
  const store = new Map<string, { key: string; value: unknown; expiresAt: Date | null }>();
  return {
    store,
    keyValue: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => store.get(where.key) ?? null),
      upsert: vi.fn(async ({ create }: { create: { key: string; value: unknown; expiresAt: Date } }) => {
        store.set(create.key, create);
        return create;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { key: string } }) => {
        store.delete(where.key);
        return { count: 1 };
      }),
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const from = { lat: 1.3521, lng: 103.8198 };
const to = { lat: 1.3501, lng: 103.8222 };
const geometry = encodePolyline([
  [from.lat, from.lng],
  [to.lat, to.lng],
]);

function make(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, creds = true) {
  const prisma = fakePrisma();
  const svc = new OneMapService(prisma as unknown as PrismaService);
  svc.credentials = creds ? { email: 'a@b.c', password: 'pw' } : null;
  const fetchFn = vi.fn((input: unknown, init?: RequestInit) => fetchImpl(String(input), init));
  svc.fetchFn = fetchFn as unknown as typeof fetch;
  return { svc, prisma, fetchFn };
}

const tokenResponse = () =>
  json({ access_token: 'tok-1', expiry_timestamp: String(Math.floor(Date.now() / 1000) + 3 * 86400) });

describe('OneMapService.walk', () => {
  it('returns null without credentials and never calls OneMap', async () => {
    const { svc, fetchFn } = make(async () => json({}), false);
    expect(await svc.walk(from, to)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fetches a token, stores it in KeyValue, decodes the route, and caches it', async () => {
    const { svc, prisma, fetchFn } = make(async (url, init) => {
      if (url.includes('getToken')) return tokenResponse();
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe('tok-1');
      expect(url).toContain('routeType=walk');
      return json({ route_geometry: geometry, route_summary: { total_distance: 412, total_time: 330 } });
    });
    const r = await svc.walk(from, to);
    expect(r).toEqual({
      distanceM: 412,
      durationS: 330,
      polyline: [
        [from.lat, from.lng],
        [to.lat, to.lng],
      ],
      source: 'onemap',
    });
    expect(prisma.store.get('onemap:token')?.value).toEqual({ token: 'tok-1' });
    await svc.walk(from, to);
    expect(fetchFn).toHaveBeenCalledTimes(2); // token + one route, second call cached
  });

  it('reuses a token cached in the database (cold instance)', async () => {
    const { svc, prisma, fetchFn } = make(async (url) => {
      if (url.includes('getToken')) throw new Error('should not fetch token');
      return json({ route_geometry: geometry, route_summary: { total_distance: 1, total_time: 1 } });
    });
    prisma.store.set('onemap:token', {
      key: 'onemap:token',
      value: { token: 'db-tok' },
      expiresAt: new Date(Date.now() + 86400_000),
    });
    expect(await svc.walk(from, to)).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('degrades to null on HTTP errors, bad payloads, and network failures', async () => {
    for (const routeRes of [
      async () => json({ error: 'x' }, 500),
      async () => json({ status: 'no route' }),
      async () => {
        throw new Error('timeout');
      },
    ]) {
      const { svc } = make(async (url) => (url.includes('getToken') ? tokenResponse() : routeRes()));
      expect(await svc.walk(from, to)).toBeNull();
    }
  });

  it('refreshes the token once on 401', async () => {
    let routeCalls = 0;
    const { svc } = make(async (url) => {
      if (url.includes('getToken')) return tokenResponse();
      routeCalls++;
      if (routeCalls === 1) return json({}, 401);
      return json({ route_geometry: geometry, route_summary: { total_distance: 5, total_time: 4 } });
    });
    expect((await svc.walk(from, to))?.durationS).toBe(4);
    expect(routeCalls).toBe(2);
  });

  it('returns null when the token request fails', async () => {
    const { svc } = make(async () => json({ error: 'bad creds' }, 401));
    expect(await svc.walk(from, to)).toBeNull();
  });
});

describe('OneMapService.search', () => {
  it('maps OneMap results and skips rows without coordinates', async () => {
    const { svc } = make(async (url) => {
      expect(url).toContain('searchVal=bishan');
      return json({
        results: [
          { SEARCHVAL: 'BISHAN MRT STATION', ADDRESS: '200 BISHAN RD', LATITUDE: '1.351', LONGITUDE: '103.848' },
          { SEARCHVAL: 'BROKEN', ADDRESS: '', LATITUDE: 'NIL', LONGITUDE: 'NIL' },
        ],
      });
    }, false);
    expect(await svc.search('bishan')).toEqual([
      { name: 'BISHAN MRT STATION', address: '200 BISHAN RD', lat: 1.351, lng: 103.848 },
    ]);
  });

  it('returns [] on failure', async () => {
    const { svc } = make(async () => {
      throw new Error('down');
    });
    expect(await svc.search('x')).toEqual([]);
  });
});
