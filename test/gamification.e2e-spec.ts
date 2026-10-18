import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { GamificationService } from '../src/gamification/gamification.service.js';
import { sgtDayStart } from '../src/gamification/sgt.js';
import {
  createContribApp,
  makeToilet,
  makeUser,
  makeVenue,
  offset,
  randomSgPoint,
  runId,
} from './contrib-fixtures.js';

describe('Gamification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let svc: GamificationService;
  const id = runId();
  const base = randomSgPoint();
  const users: string[] = [];
  let ann: Awaited<ReturnType<typeof makeUser>>;
  let ben: Awaited<ReturnType<typeof makeUser>>;
  let stationId: string;
  let toiletId: string;
  let pendingToiletId: string;

  const http = () => request(app.getHttpServer());
  const track = async (p: Promise<Awaited<ReturnType<typeof makeUser>>>) => {
    const u = await p;
    users.push(u.user.id);
    return u;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createContribApp());
    svc = app.get(GamificationService);
    ann = await track(makeUser(prisma, `ann-${id}`, { handle: `ann_${id}`, leaderboardOptIn: true }));
    ben = await track(makeUser(prisma, `ben-${id}`));
    const station = await makeVenue(prisma, base, { type: 'MRT_STATION', lines: ['NSL'], name: `E2E Station ${id}` });
    stationId = station.id;
    const t = await makeToilet(prisma, station.id, base);
    toiletId = t.id;
    await prisma.toiletFeature.createMany({
      data: [
        { toiletId, feature: 'HAND_SOAP', present: true, source: 'ADMIN', observedAt: new Date() },
        { toiletId, feature: 'SQUAT', present: false, source: 'ADMIN', observedAt: new Date() },
      ],
    });
    pendingToiletId = (await makeToilet(prisma, station.id, offset(base, 20), { status: 'PENDING' })).id;
  });

  afterAll(async () => {
    // keep the shared leaderboard clean for the next run
    await prisma.pointsLedger.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.updateMany({ where: { id: { in: users } }, data: { leaderboardOptIn: false } });
    await app.close();
  });

  it('seeds and lists badges', async () => {
    const r = await http().get('/badges').expect(200);
    expect(r.body.items.length).toBeGreaterThanOrEqual(12);
    expect(r.body.items[0]).toMatchObject({ id: 'first-flush', icon: expect.any(String) });
    expect(r.body.items.some((b: { awardedAt?: string }) => b.awardedAt)).toBe(false);
  });

  it('rejects check-ins that are too far, unauthenticated, or at a pending toilet', async () => {
    await http().post(`/toilets/${toiletId}/check-ins`).send(base).expect(401);
    const far = await http()
      .post(`/toilets/${toiletId}/check-ins`)
      .set('Cookie', ann.cookie)
      .send(offset(base, 300))
      .expect(400);
    expect(far.body.message).toMatch(/300 m/);
    await http().post(`/toilets/${pendingToiletId}/check-ins`).set('Cookie', ann.cookie).send(offset(base, 20)).expect(400);
    await http().post(`/toilets/nope/check-ins`).set('Cookie', ann.cookie).send(base).expect(404);
  });

  it('checks in, awards points and first-flush, and prompts for features', async () => {
    const r = await http()
      .post(`/toilets/${toiletId}/check-ins`)
      .set('Cookie', ann.cookie)
      .send(offset(base, 50))
      .expect(201);
    expect(r.body.distanceM).toBeGreaterThanOrEqual(49);
    expect(r.body.distanceM).toBeLessThanOrEqual(51);
    expect(r.body.pointsAwarded).toBe(4); // CHECK_IN 1 + FIRST_CHECK_IN_AT_TOILET 3
    expect(r.body.newBadges.map((b: { id: string }) => b.id)).toContain('first-flush');
    // known features first (in priority order), then unknown ones
    expect(r.body.verifyPrompt).toEqual(['HAND_SOAP', 'SQUAT', 'BIDET', 'ACCESSIBLE', 'TOILET_PAPER']);

    const row = await prisma.checkIn.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'distanceM', 'id', 'toiletId', 'userId']);

    await http().post(`/toilets/${toiletId}/check-ins`).set('Cookie', ann.cookie).send(base).expect(429);

    const badges = await http().get('/badges').set('Cookie', ann.cookie).expect(200);
    const ff = badges.body.items.find((b: { id: string }) => b.id === 'first-flush');
    expect(ff.awardedAt).toEqual(expect.any(String));
  });

  it('caps CHECK_IN points at 5 per SGT day', async () => {
    const today = sgtDayStart(new Date());
    await prisma.pointsLedger.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        userId: ben.user.id,
        reason: 'CHECK_IN' as const,
        refId: `seed-${id}-${i}`,
        delta: 1,
        createdAt: new Date(Math.max(today.getTime() + 1000, Date.now() - 1000)),
      })),
    });
    const r = await http().post(`/toilets/${toiletId}/check-ins`).set('Cookie', ben.cookie).send(base).expect(201);
    expect(r.body.pointsAwarded).toBe(3); // only FIRST_CHECK_IN_AT_TOILET
  });

  it('awards night-owl and streak-7 from check-in history', async () => {
    const owl = await track(makeUser(prisma, `owl-${id}`));
    // 7 consecutive SGT days, each at 02:00 SGT (= 18:00 UTC the day before)
    const start = sgtDayStart(new Date('2026-01-10T12:00:00Z')).getTime();
    await prisma.checkIn.createMany({
      data: Array.from({ length: 7 }, (_, i) => ({
        userId: owl.user.id,
        toiletId,
        distanceM: 10,
        createdAt: new Date(start + i * 86_400_000 + 2 * 3_600_000),
      })),
    });
    const fresh = await svc.evaluateBadges(owl.user.id);
    expect(fresh.map((b) => b.id)).toEqual(expect.arrayContaining(['first-flush', 'night-owl', 'streak-7']));
    expect(await svc.evaluateBadges(owl.user.id)).toEqual([]); // idempotent
  });

  it('verifies a listing or flags it', async () => {
    await http()
      .post(`/toilets/${toiletId}/verify`)
      .set('Cookie', ann.cookie)
      .send({ ...offset(base, 400), accurate: true })
      .expect(400);
    await http()
      .post(`/toilets/${toiletId}/verify`)
      .set('Cookie', ann.cookie)
      .send({ ...base, accurate: true })
      .expect(200, { ok: true });
    expect((await prisma.toilet.findUniqueOrThrow({ where: { id: toiletId } })).lastVerifiedAt).not.toBeNull();

    await http()
      .post(`/toilets/${toiletId}/verify`)
      .set('Cookie', ann.cookie)
      .send({ ...base, accurate: false, note: 'No bidet any more' })
      .expect(200);
    const flag = await prisma.flag.findFirstOrThrow({ where: { toiletId, userId: ann.user.id } });
    expect(flag.reason).toBe('Check-in: listing inaccurate - No bidet any more');
  });

  it('stamps the passport', async () => {
    await http().get('/me/passport').expect(401);
    const r = await http().get('/me/passport').set('Cookie', ann.cookie).expect(200);
    const st = r.body.stations.find((s: { venueId: string }) => s.venueId === stationId);
    expect(st).toMatchObject({ name: `E2E Station ${id}`, lines: ['NSL'], stampedAt: expect.any(String) });
    expect(r.body.stamped).toBeGreaterThanOrEqual(1);
    expect(r.body.total).toBeGreaterThanOrEqual(r.body.stamped);
    const other = await http().get('/me/passport').set('Cookie', (await track(makeUser(prisma, `p-${id}`))).cookie);
    expect(other.body.stations.find((s: { venueId: string }) => s.venueId === stationId).stampedAt).toBeNull();
  });

  it('ranks opted-in users with ties and fills me', async () => {
    const big = 1_000_000;
    const mk = (tag: string, optIn: boolean, handle: string | null) =>
      track(makeUser(prisma, `${tag}-${id}`, { handle, leaderboardOptIn: optIn }));
    const top = await mk('top', true, `top_${id}`);
    const tie1 = await mk('tie1', true, `tie1_${id}`);
    const tie2 = await mk('tie2', true, `tie2_${id}`);
    const hidden = await mk('hidden', false, `hidden_${id}`);
    const old = new Date(Date.now() - 30 * 86_400_000);
    const pts = (userId: string, delta: number, createdAt = new Date()) => ({
      userId,
      reason: 'SURVEY_COMPLETED' as const,
      refId: `lb-${id}-${userId}-${createdAt.getTime()}`,
      delta,
      createdAt,
    });
    await prisma.pointsLedger.createMany({
      data: [
        pts(top.user.id, big + 500),
        pts(tie1.user.id, big + 100),
        pts(tie2.user.id, big + 100),
        pts(hidden.user.id, big * 5),
        pts(tie1.user.id, big * 3, old), // only counts all-time
      ],
    });
    svc.clearLeaderboardCache();

    const week = await http().get('/leaderboard/users').query({ scope: 'week' }).set('Cookie', tie2.cookie).expect(200);
    const rank = (body: { items: { handle: string; rank: number }[] }, h: string) =>
      body.items.find((i) => i.handle === h)?.rank;
    expect(rank(week.body, `hidden_${id}`)).toBeUndefined();
    const rTop = rank(week.body, `top_${id}`)!;
    expect(rank(week.body, `tie1_${id}`)).toBe(rTop + 1);
    expect(rank(week.body, `tie2_${id}`)).toBe(rTop + 1);
    expect(week.body.me).toEqual({ rank: rTop + 1, points: big + 100 });

    const all = await http().get('/leaderboard/users').query({ scope: 'all' }).expect(200);
    expect(rank(all.body, `tie1_${id}`)).toBeLessThan(rank(all.body, `top_${id}`)!);
    expect(all.body.me).toBeNull();

    const asHidden = await http().get('/leaderboard/users').set('Cookie', hidden.cookie).expect(200);
    expect(asHidden.body.me).toEqual({ rank: null, points: big * 5 });

    await http().get('/leaderboard/users').query({ scope: 'month' }).expect(400);
  });
});
