/**
 * Shared setup for accounts.e2e-spec.ts and admin.e2e-spec.ts.
 * Env must be set before src/config/env.ts is first imported, so everything app-related is
 * imported dynamically. Only the accounts/media/admin modules are mounted, so these specs do not
 * depend on modules other agents are still building.
 */
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

export const TEST_CRON_SECRET = 'test-cron-secret-123';
export const TEST_ADMIN_EMAIL = 'e2e-admin@example.test';
export const TEST_APP_URL = 'http://app.test';

export const uid = () => randomBytes(5).toString('hex');

export async function createAccountsApp() {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    AUTH_SECRET: process.env.AUTH_SECRET || 'e2e-auth-secret-at-least-16',
    DEV_LOGIN_ENABLED: 'true',
    CRON_SECRET: TEST_CRON_SECRET,
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    ADMIN_EMAILS: TEST_ADMIN_EMAIL,
    PUBLIC_APP_URL: TEST_APP_URL,
    S3_BUCKET: '',
    S3_ACCESS_KEY_ID: '',
    S3_SECRET_ACCESS_KEY: '',
  });
  const [{ Module }, { APP_GUARD, APP_INTERCEPTOR, APP_PIPE }, { Test }, throttler, nz, cookieParser] =
    await Promise.all([
      import('@nestjs/common'),
      import('@nestjs/core'),
      import('@nestjs/testing'),
      import('../src/common/throttle.js'),
      import('nestjs-zod'),
      import('cookie-parser'),
    ]);
  const { PrismaModule } = await import('../src/prisma/prisma.module.js');
  const { AnalyticsModule } = await import('../src/analytics/analytics.module.js');
  const { PrismaService } = await import('../src/prisma/prisma.service.js');
  const { PointsModule } = await import('../src/gamification/points.module.js');
  const { AuthModule } = await import('../src/auth/auth.module.js');
  const { UsersModule } = await import('../src/users/users.module.js');
  const { MediaModule } = await import('../src/media/media.module.js');
  const { AdminModule } = await import('../src/admin/admin.module.js');
  const { StatusModule } = await import('../src/status/status.module.js');
  const { env } = await import('../src/config/env.js');

  class AccountsTestModule {}
  Module({
    imports: [
      PrismaModule,
      AnalyticsModule,
      PointsModule,
      AuthModule,
      UsersModule,
      MediaModule,
      AdminModule,
      // Signed-out status reports are merged on sign-in.
      StatusModule,
    ],
    providers: [
      { provide: APP_PIPE, useClass: nz.ZodValidationPipe },
      { provide: APP_INTERCEPTOR, useClass: nz.ZodSerializerInterceptor },
      { provide: APP_GUARD, useClass: throttler.ThrottleGuard },
    ],
  })(AccountsTestModule);

  const mod = await Test.createTestingModule({ imports: [AccountsTestModule] }).compile();
  const app: INestApplication = mod.createNestApplication({ logger: ['error'] });
  app.use(cookieParser.default());
  await app.init();
  const prisma = app.get(PrismaService);
  return { app, prisma, env, server: app.getHttpServer() };
}

/** Signs in via dev-login; returns the session cookie header and the Me body. */
export async function login(server: unknown, email: string, displayName?: string) {
  const res = await request(server as never)
    .post('/auth/dev-login')
    .send({ email, displayName })
    .expect(200);
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = setCookie.find((c) => c.startsWith('sgw_session='))!.split(';')[0];
  return { cookie, me: res.body as { id: string; role: string; [k: string]: unknown } };
}

type Prisma = Awaited<ReturnType<typeof createAccountsApp>>['prisma'];

export async function makeToilet(prisma: Prisma, status: 'ACTIVE' | 'PENDING' = 'ACTIVE') {
  const k = uid();
  const venue = await prisma.venue.create({
    data: {
      name: `E2E Venue ${k}`,
      type: 'MALL',
      latitude: 1.3,
      longitude: 103.8,
      source: 'ADMIN',
      sourceKey: `e2e:venue:${k}`,
    },
  });
  const toilet = await prisma.toilet.create({
    data: {
      venueId: venue.id,
      label: `E2E toilet ${k}`,
      latitude: 1.3,
      longitude: 103.8,
      tier: 'COMMUNITY',
      status,
      source: 'ADMIN',
      sourceKey: `e2e:toilet:${k}`,
    },
  });
  return { venue, toilet };
}

/** A tiny real JPEG. */
export async function jpegBytes(w = 640, h = 480): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width: w, height: h, channels: 3, background: '#88aaee' } })
    .jpeg()
    .toBuffer();
}
