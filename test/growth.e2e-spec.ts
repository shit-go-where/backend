import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app.factory.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { MetricsService } from '../src/metrics/metrics.service.js';
import { cookieFor, resetDb, seedFinder, type FinderFixture } from './fixtures/finder.js';

/** GROWTH.md Track 0 and 1 backend: station pages, line board, route counts, impact, verifier credit, metrics. */
describe('Growth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: FinderFixture;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    prisma = app.get(PrismaService);
    fx = await seedFinder(prisma);
  });

  afterAll(async () => {
    if (prisma) await resetDb(prisma);
    await app?.close();
  });

  describe('stations', () => {
    it('GET /stations lists every station with its toilet answer', async () => {
      const res = await http().get('/stations').expect(200);
      const bySlug = Object.fromEntries(res.body.items.map((s: { slug: string }) => [s.slug, s]));
      expect(Object.keys(bySlug).sort()).toEqual(['bishan-ccl-test', 'nearby-user-test', 'test-station']);
      expect(bySlug['test-station']).toMatchObject({
        name: 'Test Station',
        lines: [{ code: 'NSL', name: 'North-South Line' }],
        toiletStatus: 'HAS_TOILETS',
        toiletCount: 1,
        verifiedCount: 0,
        bestScore: null,
        indexable: true,
      });
      // "No toilet here" is an answer worth indexing.
      // The bad-data toilet at a NONE station is never counted.
      expect(bySlug['bishan-ccl-test']).toMatchObject({ toiletStatus: 'NONE', toiletCount: 0, indexable: true });
      expect(bySlug['nearby-user-test']).toMatchObject({ toiletStatus: 'USES_NEARBY', toiletCount: 0, indexable: true });
      // Unchecked, nothing of its own, but an open toilet within 400 m: indexable, as its page says.
      await prisma.venue.update({ where: { id: fx.venues.usesNearby.id }, data: { toiletStatus: 'UNKNOWN' } });
      const again = await http().get('/stations').expect(200);
      const unchecked = again.body.items.find((s: { slug: string }) => s.slug === 'nearby-user-test');
      expect(unchecked).toMatchObject({ toiletStatus: 'UNKNOWN', indexable: true });
      await prisma.venue.update({ where: { id: fx.venues.usesNearby.id }, data: { toiletStatus: 'USES_NEARBY' } });
    });

    it('GET /stations/:slug has its toilets, area and note', async () => {
      const res = await http().get('/stations/test-station').expect(200);
      expect(res.body).toMatchObject({
        slug: 'test-station',
        area: { slug: 'bishan', name: 'BISHAN' },
        note: null,
      });
      expect(res.body.toilets.map((t: { id: string }) => t.id)).toEqual([fx.toilets.b1.id]);
      expect(res.body.nearby).toEqual([]);
      const ccl = await http().get('/stations/bishan-ccl-test').expect(200);
      expect(ccl.body).toMatchObject({ toiletStatus: 'NONE', note: 'No toilet in the CCL station', toilets: [] });

      const none = await http().get('/stations/nearby-user-test').expect(200);
      expect(none.body).toMatchObject({ toiletStatus: 'USES_NEARBY', note: 'Use the toilet in Test Mall', toilets: [] });
      // The mall's toilets are about 300 m away: listed nearest first, never the pending one.
      const near = none.body.nearby as { toilet: { id: string }; distanceM: number }[];
      expect(near.map((n) => n.toilet.id)).toEqual([fx.toilets.a1.id, fx.toilets.a2.id]);
      expect(near[0].distanceM).toBeLessThanOrEqual(400);
    });

    it('GET /stations/:slug 404s for an unknown station', async () => {
      await http().get('/stations/atlantis').expect(404);
    });

    it('GET /leaderboard/lines ranks lines by station scores', async () => {
      await prisma.toilet.update({ where: { id: fx.toilets.b1.id }, data: { scoreCleanliness: 7 } });
      const res = await http().get('/leaderboard/lines').expect(200);
      expect(res.body.items).toEqual([
        expect.objectContaining({ rank: 1, code: 'NSL', stations: 1, stationsWithToilets: 1, avgScore: 7 }),
        expect.objectContaining({ rank: 2, code: 'CCL', stations: 1, stationsWithToilets: 0, avgScore: null }),
      ]);
    });
  });

  describe('route counts and impact', () => {
    it('POST /routing/started counts per toilet per day and rejects inactive toilets', async () => {
      await http().post('/routing/started').send({ toiletId: fx.toilets.a1.id }).expect(200, { ok: true });
      await http().post('/routing/started').send({ toiletId: fx.toilets.a1.id }).expect(200);
      const rows = await prisma.toiletRouteDaily.findMany({ where: { toiletId: fx.toilets.a1.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(2);
      await http().post('/routing/started').send({ toiletId: fx.toilets.pending.id }).expect(404);
      await http().post('/routing/started').send({ toiletId: 'nope' }).expect(404);
    });

    it('GET /me reports toilets helped and routes to them', async () => {
      const { u1, u2 } = fx.users;
      await prisma.toilet.update({ where: { id: fx.toilets.a1.id }, data: { createdById: u1.id } });
      const me = await http().get('/me').set('Cookie', cookieFor(u1.id)).expect(200);
      expect(me.body.impact).toEqual({ toilets: 1, routedWeek: 2 });
      expect(me.body.verifierCredit).toBe(true);
      // Never seen activity: routes since sign-up day are not "since last visit" until the next day.
      expect(typeof me.body.unseen.routed).toBe('number');

      const other = await http().get('/me').set('Cookie', cookieFor(u2.id)).expect(200);
      expect(other.body.impact).toEqual({ toilets: 0, routedWeek: 0 });
    });
  });

  describe('verifier credit', () => {
    it('shows the last verifier by handle until they opt out', async () => {
      const { u2 } = fx.users;
      const a1 = fx.toilets.a1;
      await http()
        .post(`/toilets/${a1.id}/verify`)
        .set('Cookie', cookieFor(u2.id))
        .send({ lat: a1.latitude, lng: a1.longitude, accurate: true })
        .expect(200);
      let detail = await http().get(`/toilets/${a1.id}`).expect(200);
      expect(detail.body.verifiedBy).toEqual({ handle: 'user_two' });

      await http().patch('/me').set('Cookie', cookieFor(u2.id)).send({ verifierCredit: false }).expect(200);
      detail = await http().get(`/toilets/${a1.id}`).expect(200);
      expect(detail.body.verifiedBy).toBeNull();
      expect(detail.body.lastVerifiedAt).not.toBeNull();

      // Verifying counts as helping that toilet.
      const me = await http().get('/me').set('Cookie', cookieFor(u2.id)).expect(200);
      expect(me.body.impact.toilets).toBe(1);
    });
  });

  describe('metrics', () => {
    it('computes the day: contributors, counts, freshness and tiers, idempotently', async () => {
      const { u1, u3 } = fx.users;
      const now = new Date();
      await prisma.checkIn.createMany({
        data: [
          { userId: u1.id, toiletId: fx.toilets.a1.id, distanceM: 10, createdAt: now },
          { deviceId: 'dev-1', toiletId: fx.toilets.a1.id, distanceM: 20, createdAt: now },
        ],
      });
      await prisma.statusReport.create({
        data: { toiletId: fx.toilets.a1.id, userId: u3.id, kind: 'NO_PAPER', expiresAt: new Date(now.getTime() + 3_600_000) },
      });
      const metrics = app.get(MetricsService);
      const day = await metrics.compute(now);
      expect(day).toMatchObject({ contributors: 3, wac: 3, checkIns: 2, statusReports: 1 });
      // a1 was just verified (fresh); a2 (community) and e1 never were. closed/pending are not ACTIVE.
      expect(day.freshPct).toBeCloseTo(33.3, 1);
      expect(day.toiletsByTier).toEqual({ VERIFIED: 1, COMMUNITY: 2, IMPORTED: 2 });
      expect(day.pendingCount).toBe(1);

      const again = await metrics.compute(now);
      expect(again).toEqual(day);
      expect(await prisma.metricsDaily.count()).toBe(1);
      expect(await metrics.latest()).toEqual(day);
    });
  });
});
