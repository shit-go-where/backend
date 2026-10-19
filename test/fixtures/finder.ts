/**
 * Fixture data for finder e2e tests. Wipes and seeds the database pointed to by DATABASE_URL,
 * so only run it against a throwaway test database.
 */
import type { INestApplication } from '@nestjs/common';
import type { Feature } from '../../src/generated/prisma/enums.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { SESSION_COOKIE, createSessionToken } from '../../src/common/auth/session.js';

/** Test origin (around Bishan). */
export const ORIGIN = { lat: 1.351, lng: 103.848 } as const;
/** ~2.2 km south of venue E, > 3 km from everything else: exercises urgent radius widening. */
export const FAR_ORIGIN = { lat: 1.4, lng: 103.848 } as const;

/** Offset in metres north/east of ORIGIN. */
export function offset(northM: number, eastM = 0, from: { lat: number; lng: number } = ORIGIN) {
  return {
    lat: from.lat + northM / 111_320,
    lng: from.lng + eastM / (111_320 * Math.cos((from.lat * Math.PI) / 180)),
  };
}

export function cookieFor(userId: string): string {
  return `${SESSION_COOKIE}=${createSessionToken(userId)}`;
}

const TABLES = [
  'StatusConfirmation',
  'StatusReport',
  'Flag',
  'Photo',
  'Review',
  'SubmissionVote',
  'Submission',
  'CheckIn',
  'PointsLedger',
  'UserBadge',
  'Survey',
  'ToiletFeature',
  'Toilet',
  'Venue',
  'User',
  'KeyValue',
  'MetricsDaily',
];

export async function resetDb(prisma: PrismaService) {
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

async function features(prisma: PrismaService, toiletId: string, present: Feature[], absent: Feature[] = []) {
  await prisma.toiletFeature.createMany({
    data: [
      ...present.map((feature) => ({ toiletId, feature, present: true, source: 'FIELDWORK_2024' as const, observedAt: new Date('2024-03-15') })),
      ...absent.map((feature) => ({ toiletId, feature, present: false, source: 'FIELDWORK_2024' as const, observedAt: new Date('2024-03-15') })),
    ],
  });
}

export type FinderFixture = Awaited<ReturnType<typeof seedFinder>>;

export async function seedFinder(prisma: PrismaService) {
  await resetDb(prisma);
  const pos = (p: { lat: number; lng: number }) => ({ latitude: p.lat, longitude: p.lng });

  const mall = await prisma.venue.create({
    data: {
      name: 'Test Mall', type: 'MALL', ...pos(offset(100)), toiletStatus: 'HAS_TOILETS',
      planningArea: 'BISHAN', address: '1 Test Road', source: 'ADMIN', sourceKey: 'test:mall',
      openingHours: { type: 'always' },
    },
  });
  const station = await prisma.venue.create({
    data: {
      name: 'Test Station', type: 'MRT_STATION', lines: ['NSL'], ...pos(offset(-600)),
      toiletStatus: 'HAS_TOILETS', planningArea: 'BISHAN', source: 'ADMIN', sourceKey: 'test:station',
    },
  });
  const noToilet = await prisma.venue.create({
    data: {
      name: 'Bishan CCL Test', type: 'MRT_STATION', lines: ['CCL'], ...pos(offset(0, 200)),
      toiletStatus: 'NONE', note: 'No toilet in the CCL station', source: 'ADMIN', sourceKey: 'test:none',
    },
  });
  const usesNearby = await prisma.venue.create({
    data: {
      name: 'Nearby User Test', type: 'MRT_STATION', ...pos(offset(0, -300)),
      toiletStatus: 'USES_NEARBY', note: 'Use the toilet in Test Mall', source: 'ADMIN', sourceKey: 'test:nearby',
    },
  });
  const farVenue = await prisma.venue.create({
    data: {
      name: 'Far Hawker', type: 'HAWKER_CENTRE', ...pos(offset(2200, 0, FAR_ORIGIN)),
      toiletStatus: 'HAS_TOILETS', planningArea: 'TOA PAYOH', source: 'ADMIN', sourceKey: 'test:far',
    },
  });

  // A1: best toilet. Verified 2024 survey, bidet + accessible, clean 8.2.
  const a1 = await prisma.toilet.create({
    data: {
      venueId: mall.id, label: 'L1 near lifts', ...pos(offset(100)), level: 'L1', areaType: 'UNPAID_AREA',
      tier: 'VERIFIED', source: 'FIELDWORK_2024', sourceKey: 'test:a1', scoreCleanliness: 8.2,
      lastVerifiedAt: new Date('2024-03-15'), openingHours: { type: 'always' },
    },
  });
  await features(prisma, a1.id, ['BIDET', 'ACCESSIBLE', 'TOILET_PAPER'], ['SQUAT']);
  await prisma.survey.create({
    data: {
      toiletId: a1.id, surveyedAt: new Date('2024-03-15'), cleanliness: 8, scent: 4, aesthetics: 4,
      music: 2, toiletries: 5, facilities: 17, total: 40, rasStars: 4, raw: {},
    },
  });
  // A2: community toilet in the same mall, closed by its own hours (weekly with no periods).
  const a2 = await prisma.toilet.create({
    data: {
      venueId: mall.id, label: 'B1 food court', ...pos(offset(120)), level: 'B1', areaType: 'PAID_AREA',
      tier: 'COMMUNITY', source: 'COMMUNITY', sourceKey: 'test:a2', scoreCleanliness: 5,
      openingHours: { type: 'weekly', periods: [] },
    },
  });
  await features(prisma, a2.id, ['TOILET_PAPER']);
  // B1: imported from OSM, no score, 24/7.
  const b1 = await prisma.toilet.create({
    data: {
      venueId: station.id, ...pos(offset(-600)), tier: 'IMPORTED', source: 'OSM', sourceKey: 'test:b1',
      openingHours: { type: 'osm', value: '24/7' },
    },
  });
  // C1: belongs to a NONE venue (bad data) — must never show up.
  const c1 = await prisma.toilet.create({
    data: { venueId: noToilet.id, ...pos(offset(0, 200)), tier: 'IMPORTED', source: 'OSM', sourceKey: 'test:c1' },
  });
  // P: pending community submission.
  const pending = await prisma.toilet.create({
    data: {
      venueId: mall.id, label: 'Pending one', ...pos(offset(90)), tier: 'COMMUNITY', status: 'PENDING',
      source: 'COMMUNITY', sourceKey: 'test:pending',
    },
  });
  // CLOSED: under renovation.
  const closed = await prisma.toilet.create({
    data: {
      venueId: mall.id, label: 'Renovating', ...pos(offset(95)), tier: 'VERIFIED', status: 'RENOVATION',
      source: 'FIELDWORK_2024', sourceKey: 'test:closed', scoreCleanliness: 9.9,
    },
  });
  // E1: far away, data.gov sourced.
  const e1 = await prisma.toilet.create({
    data: {
      venueId: farVenue.id, ...pos(offset(2200, 0, FAR_ORIGIN)), tier: 'COMMUNITY', source: 'DATAGOV',
      sourceKey: 'test:e1', scoreCleanliness: 6.5,
    },
  });

  const [u1, u2, u3] = await Promise.all(
    ['one', 'two', 'three'].map((h) =>
      prisma.user.create({ data: { email: `${h}@test.local`, handle: `user_${h}`, displayName: `User ${h}` } }),
    ),
  );
  const photo = (id: string, uploadedById: string, confirmed: boolean) =>
    prisma.photo.create({
      data: {
        id, key: `test/${id}.jpg`, url: `http://files.test/${id}.jpg`, thumbUrl: `http://files.test/${id}_t.jpg`,
        contentType: 'image/jpeg', uploadedById, confirmed,
      },
    });
  const photos = {
    u1Confirmed: await photo('photo-u1-ok', u1.id, true),
    u1Unconfirmed: await photo('photo-u1-pending', u1.id, false),
    u2Confirmed: await photo('photo-u2-ok', u2.id, true),
  };

  return {
    venues: { mall, station, noToilet, usesNearby, farVenue },
    toilets: { a1, a2, b1, c1, pending, closed, e1 },
    users: { u1, u2, u3 },
    photos,
  };
}

export async function getPrisma(app: INestApplication) {
  return app.get(PrismaService);
}
