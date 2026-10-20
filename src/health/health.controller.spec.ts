import { HealthController } from './health.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';

describe('HealthController.live', () => {
  const saved = process.env.VERCEL_GIT_COMMIT_SHA;
  afterEach(() => {
    if (saved === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = saved;
  });

  it('answers without touching the database', () => {
    const queryRaw = vi.fn();
    const controller = new HealthController({ $queryRaw: queryRaw } as unknown as PrismaService);
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const res = controller.live();
    expect(res).toMatchObject({ ok: true, commit: null });
    expect(new Date(res.time).getTime()).not.toBeNaN();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('reports the deployed commit', () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc123';
    const controller = new HealthController({} as PrismaService);
    expect(controller.live().commit).toBe('abc123');
  });
});
