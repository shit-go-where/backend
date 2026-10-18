/** Shared fixtures for submissions / gamification e2e specs. */
import { Module, type INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PointsModule } from '../src/gamification/points.module.js';
import { GamificationModule } from '../src/gamification/gamification.module.js';
import { SubmissionsModule } from '../src/submissions/submissions.module.js';
import { createSessionToken } from '../src/common/auth/session.js';
import type { Role, VenueType } from '../src/generated/prisma/enums.js';

/** Only the modules under test, so other features' modules cannot break these specs. */
@Module({
  imports: [PrismaModule, PointsModule, GamificationModule, SubmissionsModule],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
class ContribTestModule {}

export async function createContribApp(): Promise<{ app: INestApplication; prisma: PrismaService }> {
  const moduleRef = await Test.createTestingModule({ imports: [ContribTestModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  return { app, prisma: app.get(PrismaService) };
}

export const runId = () => Math.random().toString(36).slice(2, 10);

/** A random point well inside Singapore, so concurrent runs do not collide. */
export function randomSgPoint() {
  return { lat: 1.3 + Math.random() * 0.08, lng: 103.72 + Math.random() * 0.2 };
}

/** Offset a point by metres north/east. */
export function offset(p: { lat: number; lng: number }, northM: number, eastM = 0) {
  return {
    lat: p.lat + northM / 111_320,
    lng: p.lng + eastM / (111_320 * Math.cos((p.lat * Math.PI) / 180)),
  };
}

export async function makeUser(
  prisma: PrismaService,
  tag: string,
  opts: { role?: Role; handle?: string | null; leaderboardOptIn?: boolean } = {},
) {
  const user = await prisma.user.create({
    data: {
      email: `${tag}@e2e.test`,
      displayName: tag,
      role: opts.role ?? 'USER',
      handle: opts.handle ?? null,
      leaderboardOptIn: opts.leaderboardOptIn ?? false,
    },
  });
  return { user, cookie: `sgw_session=${createSessionToken(user.id)}` };
}

export async function makePhoto(prisma: PrismaService, userId: string, confirmed = true) {
  const key = `e2e/${runId()}-${runId()}.jpg`;
  return prisma.photo.create({
    data: { key, url: `https://img.test/${key}`, contentType: 'image/jpeg', uploadedById: userId, confirmed },
  });
}

export async function makeVenue(
  prisma: PrismaService,
  p: { lat: number; lng: number },
  opts: { type?: VenueType; lines?: string[]; name?: string } = {},
) {
  return prisma.venue.create({
    data: {
      name: opts.name ?? `E2E venue ${runId()}`,
      type: opts.type ?? 'MALL',
      latitude: p.lat,
      longitude: p.lng,
      lines: opts.lines ?? [],
      toiletStatus: 'HAS_TOILETS',
      source: 'ADMIN',
      sourceKey: `e2e-venue:${runId()}${runId()}`,
    },
  });
}

export async function makeToilet(
  prisma: PrismaService,
  venueId: string,
  p: { lat: number; lng: number },
  opts: { status?: 'ACTIVE' | 'PENDING'; level?: string } = {},
) {
  return prisma.toilet.create({
    data: {
      venueId,
      latitude: p.lat,
      longitude: p.lng,
      level: opts.level ?? null,
      tier: 'VERIFIED',
      status: opts.status ?? 'ACTIVE',
      source: 'ADMIN',
      sourceKey: `e2e-toilet:${runId()}${runId()}`,
    },
  });
}
