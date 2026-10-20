import { BADGES } from './badges.js';
import { onVercel, syncBadges } from './badge-sync.js';
import { GamificationService } from './gamification.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { PointsService } from './points.service.js';
import type { AnalyticsService } from '../analytics/analytics.service.js';

function fakeDb() {
  return {
    badge: { upsert: vi.fn((args: unknown) => args) },
    $transaction: vi.fn((ops: unknown[]) => Promise.resolve(ops)),
  };
}

describe('syncBadges', () => {
  it('upserts every badge in one transaction', async () => {
    const db = fakeDb();
    expect(await syncBadges(db as never)).toBe(BADGES.length);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.badge.upsert).toHaveBeenCalledTimes(BADGES.length);
    expect(db.badge.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { id: BADGES[0].id } }));
  });
});

describe('onVercel', () => {
  it('detects a Vercel build or runtime', () => {
    expect(onVercel({ VERCEL: '1' })).toBe(true);
    expect(onVercel({ VERCEL_ENV: 'production' })).toBe(true);
    expect(onVercel({})).toBe(false);
  });
});

describe('GamificationService.onApplicationBootstrap', () => {
  const saved = { VERCEL: process.env.VERCEL, VERCEL_ENV: process.env.VERCEL_ENV };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const service = (db: ReturnType<typeof fakeDb>) =>
    new GamificationService(db as unknown as PrismaService, {} as PointsService, {} as AnalyticsService);

  it('runs no database query on Vercel (the build syncs badges)', async () => {
    process.env.VERCEL_ENV = 'production';
    const db = fakeDb();
    await service(db).onApplicationBootstrap();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.badge.upsert).not.toHaveBeenCalled();
  });

  it('syncs badges off Vercel, and a database outage does not fail the boot', async () => {
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    const db = fakeDb();
    await service(db).onApplicationBootstrap();
    expect(db.$transaction).toHaveBeenCalledTimes(1);

    const down = fakeDb();
    down.$transaction.mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    await expect(service(down).onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
