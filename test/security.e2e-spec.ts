/**
 * Authorisation and abuse rules (production readiness audit §5): object ownership (IDOR) per
 * resource, role guards, the anonymous device cookie, trust escalation and the races that used to
 * slip past cooldowns and caps. Runs against the full app (createApp), throttle guard included.
 */
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app.factory.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createAnonToken } from '../src/common/auth/anon.js';
import { TRUSTED_THRESHOLD } from '../src/gamification/points.service.js';
import { MediaService } from '../src/media/media.service.js';
import { S3Storage, type Storage } from '../src/media/storage.js';
import { makePhoto, makeToilet, makeUser, makeVenue, offset, randomSgPoint, runId } from './contrib-fixtures.js';

type U = Awaited<ReturnType<typeof makeUser>>;

describe('Security: authorisation, IDOR and abuse rules (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const id = runId();
  let alice: U; // owner of things
  let bob: U; // another signed-in user
  let tess: U; // TRUSTED
  let mo: U; // MODERATOR
  const http = () => request(app.getHttpServer());

  /** An ACTIVE toilet at a fresh random point. */
  const toiletAt = async (p = randomSgPoint()) => {
    const venue = await makeVenue(prisma, p);
    return { toilet: await makeToilet(prisma, venue.id, p), p };
  };

  /** A NEW_TOILET submission by `who` with no location (stays PENDING). */
  const pendingSubmission = async (who: U, photo = true) => {
    const pin = randomSgPoint();
    const photoIds = photo ? [(await makePhoto(prisma, who.user.id)).id] : [];
    const res = await http()
      .post('/submissions')
      .set('Cookie', who.cookie)
      .send({ kind: 'NEW_TOILET', force: true, payload: { lat: pin.lat, lng: pin.lng, features: {}, photoIds } })
      .expect(201);
    return res.body as { id: string; toilet: { id: string }; photos: { id: string }[] };
  };

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    prisma = app.get(PrismaService);
    alice = await makeUser(prisma, `sec-alice-${id}`);
    bob = await makeUser(prisma, `sec-bob-${id}`);
    tess = await makeUser(prisma, `sec-tess-${id}`, { role: 'TRUSTED' });
    mo = await makeUser(prisma, `sec-mo-${id}`, { role: 'MODERATOR' });
  });

  afterAll(async () => {
    await app.close();
  });

  // ───────────── submissions ─────────────

  describe('submissions', () => {
    it("another user cannot change someone's submission (404, not 403, so ids are not confirmed)", async () => {
      const sub = await pendingSubmission(alice, false);
      await prisma.submission.update({ where: { id: sub.id }, data: { state: 'NEEDS_INFO' } });
      await http().patch(`/submissions/${sub.id}`).set('Cookie', bob.cookie).send({ note: 'mine now' }).expect(404);
      await http().patch(`/submissions/${sub.id}`).set('Cookie', tess.cookie).send({ note: 'mine now' }).expect(404);
      const row = await prisma.submission.findUniqueOrThrow({ where: { id: sub.id } });
      expect((row.payload as { note?: string }).note).toBeUndefined();
      // The owner can.
      await http().patch(`/submissions/${sub.id}`).set('Cookie', alice.cookie).send({ note: 'more info' }).expect(200);
    });

    it('cannot vote on your own submission', async () => {
      const sub = await pendingSubmission(alice, false);
      await http().post(`/submissions/${sub.id}/votes`).set('Cookie', alice.cookie).send({ value: 'APPROVE' }).expect(403);
    });

    it('resolve and the island-wide queue need MODERATOR+', async () => {
      const sub = await pendingSubmission(alice, false);
      for (const who of [alice, bob, tess]) {
        await http().post(`/submissions/${sub.id}/resolve`).set('Cookie', who.cookie).send({ state: 'APPROVED' }).expect(403);
        await http().get('/admin/submissions').set('Cookie', who.cookie).expect(403);
      }
      await http().post(`/submissions/${sub.id}/resolve`).send({ state: 'APPROVED' }).expect(401);
      await http().post(`/submissions/${sub.id}/resolve`).set('Cookie', mo.cookie).send({ state: 'REJECTED' }).expect(200);
    });

    it("hides a decided submission's unapproved photos from everyone but the submitter and moderators", async () => {
      const sub = await pendingSubmission(alice, true);
      const photoId = sub.photos[0]!.id;
      // Open: reviewers see the photo they are asked to judge.
      const open = await http().get(`/submissions/${sub.id}`).set('Cookie', bob.cookie).expect(200);
      expect(open.body.photos.map((p: { id: string }) => p.id)).toEqual([photoId]);

      await http().post(`/submissions/${sub.id}/resolve`).set('Cookie', mo.cookie).send({ state: 'REJECTED' }).expect(200);
      const asBob = await http().get(`/submissions/${sub.id}`).set('Cookie', bob.cookie).expect(200);
      expect(asBob.body.photos).toEqual([]);
      const asAlice = await http().get(`/submissions/${sub.id}`).set('Cookie', alice.cookie).expect(200);
      expect(asAlice.body.photos.map((p: { id: string }) => p.id)).toEqual([photoId]);
      const asMo = await http().get(`/submissions/${sub.id}`).set('Cookie', mo.cookie).expect(200);
      expect(asMo.body.photos.map((p: { id: string }) => p.id)).toEqual([photoId]);

      // Once approved it is public anyway.
      await prisma.photo.update({ where: { id: photoId }, data: { approved: true } });
      const later = await http().get(`/submissions/${sub.id}`).set('Cookie', bob.cookie).expect(200);
      expect(later.body.photos.map((p: { id: string }) => p.id)).toEqual([photoId]);
    });

    it('photo read URLs follow the same visibility, as short-lived presigned redirects (private bucket)', async () => {
      // Signing needs no network, so a fake R2 endpoint shows exactly what the browser is sent.
      const media = app.get(MediaService) as unknown as { storage: Storage };
      const local = media.storage;
      media.storage = new S3Storage({
        bucket: 'sgw-photos',
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'secret',
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        region: 'auto',
      });
      try {
        const sub = await pendingSubmission(alice, true);
        const photoId = sub.photos[0]!.id;
        const read = (cookie?: string) => {
          const r = http().get(`/media/photos/${photoId}`);
          return cookie ? r.set('Cookie', cookie) : r;
        };
        // Open submission: any signed-in reviewer, never anonymous; nothing is cacheable.
        const asBob = await read(bob.cookie).expect(302);
        expect(asBob.headers['cache-control']).toBe('private, no-store');
        const loc = new URL(asBob.headers.location as string);
        expect(loc.host).toBe('acct.r2.cloudflarestorage.com');
        expect(loc.pathname).toMatch(/^\/sgw-photos\/photos\/e2e-/);
        expect(loc.searchParams.get('X-Amz-Expires')).toBe('600');
        await read().expect(404);

        await http().post(`/submissions/${sub.id}/resolve`).set('Cookie', mo.cookie).send({ state: 'REJECTED' }).expect(200);
        // Decided and unapproved: the uploader and TRUSTED+ only.
        await read(bob.cookie).expect(404);
        await read().expect(404);
        await read(alice.cookie).expect(302);
        await read(tess.cookie).expect(302);
        await read(mo.cookie).expect(302);

        // Approved: public, signed for the hour window, cacheable until it ends.
        await prisma.photo.update({ where: { id: photoId }, data: { approved: true } });
        const pub = await read().expect(302);
        expect(pub.headers['cache-control']).toMatch(/^public, max-age=\d+, s-maxage=\d+$/);
        expect(new URL(pub.headers.location as string).searchParams.get('X-Amz-Expires')).toBe('7200');
        // No thumbnail on this row: 404, not a URL to a missing object.
        await http().get(`/media/photos/${photoId}/thumb`).expect(404);

        // An upload that was never confirmed has no read URL for anyone, its uploader included.
        const raw = await makePhoto(prisma, alice.user.id, false);
        await http().get(`/media/photos/${raw.id}`).set('Cookie', alice.cookie).expect(404);
        await http().get(`/media/photos/${raw.id}`).set('Cookie', mo.cookie).expect(404);
      } finally {
        media.storage = local;
      }
    });

    it('parallel on-site submissions cannot beat the 3-a-day auto-publish cap', async () => {
      const carl = await makeUser(prisma, `sec-carl-${id}`);
      const sends = Array.from({ length: 6 }, async () => {
        const pin = randomSgPoint();
        const photo = await makePhoto(prisma, carl.user.id);
        return http()
          .post('/submissions')
          .set('Cookie', carl.cookie)
          .send({
            kind: 'NEW_TOILET',
            ...offset(pin, 20),
            force: true,
            payload: { lat: pin.lat, lng: pin.lng, features: {}, photoIds: [photo.id] },
          });
      });
      const results = await Promise.all(sends);
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
      expect(await prisma.submission.count({ where: { submittedById: carl.user.id, autoPublished: true } })).toBe(3);
    });
  });

  // ───────────── reviews and photos ─────────────

  describe('reviews and photos', () => {
    it("cannot attach someone else's photo to your review", async () => {
      const { toilet } = await toiletAt();
      const photo = await makePhoto(prisma, alice.user.id);
      await http()
        .post(`/toilets/${toilet.id}/reviews`)
        .set('Cookie', bob.cookie)
        .send({ cleanliness: 5, photoIds: [photo.id] })
        .expect(400);
      expect((await prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).reviewId).toBeNull();
    });

    it("a review upsert only ever touches the caller's own review", async () => {
      const { toilet } = await toiletAt();
      await http().post(`/toilets/${toilet.id}/reviews`).set('Cookie', alice.cookie).send({ cleanliness: 5, comment: 'clean' }).expect(201);
      await http().post(`/toilets/${toilet.id}/reviews`).set('Cookie', bob.cookie).send({ cleanliness: 1, comment: 'dirty' }).expect(201);
      const rows = await prisma.review.findMany({ where: { toiletId: toilet.id }, orderBy: { cleanliness: 'asc' } });
      expect(rows.map((r) => [r.userId, r.comment])).toEqual([
        [bob.user.id, 'dirty'],
        [alice.user.id, 'clean'],
      ]);
    });

    it('public reviews and the leaderboard never carry the Google avatar URL', async () => {
      const { toilet } = await toiletAt();
      const ava = await makeUser(prisma, `sec-ava-${id}`, { handle: `ava_${id}`, leaderboardOptIn: true });
      await prisma.user.update({ where: { id: ava.user.id }, data: { avatarUrl: 'https://lh3.googleusercontent.com/a/face' } });
      await http().post(`/toilets/${toilet.id}/reviews`).set('Cookie', ava.cookie).send({ cleanliness: 4 }).expect(201);
      const list = await http().get(`/toilets/${toilet.id}/reviews`).expect(200);
      expect(list.body.items[0].user).toEqual({ handle: `ava_${id}`, avatarUrl: null });
      const board = await http().get('/leaderboard/users?scope=all').expect(200);
      expect(JSON.stringify(board.body)).not.toContain('googleusercontent');
    });

    it("cannot confirm someone else's upload (404)", async () => {
      const presign = await http()
        .post('/media/presign')
        .set('Cookie', alice.cookie)
        .send({ contentType: 'image/jpeg', size: 1000 })
        .expect(200);
      await http().post(`/media/${presign.body.photoId}/confirm`).set('Cookie', bob.cookie).expect(404);
      await http().post(`/media/${presign.body.photoId}/confirm`).expect(401);
    });

    it('photo moderation: USER cannot approve, TRUSTED cannot approve their own or reject', async () => {
      const own = await makePhoto(prisma, tess.user.id);
      const other = await makePhoto(prisma, alice.user.id);
      await http().get('/admin/photos/pending').set('Cookie', bob.cookie).expect(403);
      await http().post(`/admin/photos/${other.id}/approve`).set('Cookie', bob.cookie).expect(403);
      await http().post(`/admin/photos/${own.id}/approve`).set('Cookie', tess.cookie).expect(403);
      await http().post(`/admin/photos/${other.id}/reject`).set('Cookie', tess.cookie).expect(403);
      const r = await http().post(`/admin/photos/${other.id}/approve`).set('Cookie', tess.cookie).expect(200);
      expect(r.body).toEqual({ approved: false, approvals: 1 });
      expect(await prisma.photo.count({ where: { id: { in: [own.id, other.id] } } })).toBe(2);
    });

    it('ten photo reviews no longer make anyone TRUSTED on their own', async () => {
      const eve = await makeUser(prisma, `sec-eve-${id}`);
      for (let i = 0; i < 10; i++) {
        const { toilet } = await toiletAt();
        const photo = await makePhoto(prisma, eve.user.id);
        await http()
          .post(`/toilets/${toilet.id}/reviews`)
          .set('Cookie', eve.cookie)
          .send({ cleanliness: 5, photoIds: [photo.id] })
          .expect(201);
      }
      const u = await prisma.user.findUniqueOrThrow({ where: { id: eve.user.id } });
      expect(u).toMatchObject({ role: 'USER', trustScore: 0 });
      // Points still count for the leaderboard: 10 x (REVIEW_POSTED 5 + REVIEW_WITH_PHOTO 5).
      const sum = await prisma.pointsLedger.aggregate({ where: { userId: eve.user.id }, _sum: { delta: true } });
      expect(sum._sum.delta).toBe(100);
      expect(100).toBeGreaterThan(TRUSTED_THRESHOLD);
    });
  });

  // ───────────── status reports ─────────────

  describe('status reports', () => {
    it('cannot confirm your own report; signed out cannot confirm at all', async () => {
      const { toilet } = await toiletAt();
      const r = await http().post(`/toilets/${toilet.id}/status`).set('Cookie', alice.cookie).send({ kind: 'NO_PAPER' }).expect(201);
      await http().post(`/status/${r.body.id}/confirm`).set('Cookie', alice.cookie).expect(400);
      await http().post(`/status/${r.body.id}/confirm`).expect(401);
    });

    it('one confirmer earns a reporter STATUS_CONFIRMED at most once a day (no two-account trust farm)', async () => {
      const rex = await makeUser(prisma, `sec-rex-${id}`);
      const cid = await makeUser(prisma, `sec-cid-${id}`);
      const dan = await makeUser(prisma, `sec-dan-${id}`);
      const reports: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { toilet } = await toiletAt();
        const r = await http().post(`/toilets/${toilet.id}/status`).set('Cookie', rex.cookie).send({ kind: 'NO_PAPER' }).expect(201);
        reports.push(r.body.id);
      }
      for (const reportId of reports) {
        const c = await http().post(`/status/${reportId}/confirm`).set('Cookie', cid.cookie).expect(200);
        // The confirmation itself still counts for the report.
        expect(c.body.confirmations).toBe(1);
      }
      await http().post(`/status/${reports[0]}/confirm`).set('Cookie', dan.cookie).expect(200);
      const paid = await prisma.pointsLedger.findMany({ where: { userId: rex.user.id, reason: 'STATUS_CONFIRMED' } });
      expect(paid.map((p) => p.refId.split(':')[1]).sort()).toEqual([cid.user.id, dan.user.id].sort());
      expect((await prisma.user.findUniqueOrThrow({ where: { id: rex.user.id } })).trustScore).toBe(4);
    });
  });

  // ───────────── check-ins and the anonymous device ─────────────

  describe('check-ins and the anonymous device', () => {
    it('parallel check-ins at one toilet: one succeeds, the rest hit the 2 h cooldown', async () => {
      const fay = await makeUser(prisma, `sec-fay-${id}`);
      const { toilet, p } = await toiletAt();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => http().post(`/toilets/${toilet.id}/check-ins`).set('Cookie', fay.cookie).send(p)),
      );
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 429, 429, 429, 429, 429]);
      expect(await prisma.checkIn.count({ where: { userId: fay.user.id } })).toBe(1);
      const pts = await prisma.pointsLedger.count({ where: { userId: fay.user.id, reason: 'CHECK_IN' } });
      expect(pts).toBe(1);
    });

    it('a forged sgw_anon cookie is replaced, never trusted', async () => {
      const { toilet, p } = await toiletAt();
      const victim = crypto.randomUUID();
      const forged = `${victim}.${'A'.repeat(43)}`;
      const res = await http().post(`/toilets/${toilet.id}/check-ins`).set('Cookie', `sgw_anon=${forged}`).send(p).expect(201);
      const issued = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('sgw_anon='));
      expect(issued).toBeDefined();
      expect(issued).not.toContain(victim);
      expect(await prisma.checkIn.count({ where: { deviceId: victim } })).toBe(0);
    });

    it('a valid device cookie only ever reaches its own device id', async () => {
      const { toilet, p } = await toiletAt();
      const device = crypto.randomUUID();
      await http().post(`/toilets/${toilet.id}/check-ins`).set('Cookie', `sgw_anon=${createAnonToken(device)}`).send(p).expect(201);
      expect(await prisma.checkIn.count({ where: { deviceId: device, userId: null } })).toBe(1);
    });

    it('signed out cannot check in at a pending toilet', async () => {
      const p = randomSgPoint();
      const venue = await makeVenue(prisma, p);
      const t = await makeToilet(prisma, venue.id, p, { status: 'PENDING' });
      await http().post(`/toilets/${t.id}/check-ins`).send(p).expect(401);
    });
  });

  // ───────────── admin ─────────────

  describe('admin', () => {
    it('roles: only ADMIN changes roles, MODERATOR+ patches toilets and resolves flags', async () => {
      const { toilet } = await toiletAt();
      for (const who of [bob, tess, mo]) {
        await http().patch(`/admin/users/${bob.user.id}/role`).set('Cookie', who.cookie).send({ role: 'ADMIN' }).expect(403);
      }
      expect((await prisma.user.findUniqueOrThrow({ where: { id: bob.user.id } })).role).toBe('USER');
      for (const who of [bob, tess]) {
        await http().patch(`/admin/toilets/${toilet.id}`).set('Cookie', who.cookie).send({ status: 'CLOSED' }).expect(403);
        await http().get('/admin/flags').set('Cookie', who.cookie).expect(403);
      }
      await http().patch(`/admin/toilets/${toilet.id}`).send({ status: 'CLOSED' }).expect(401);
      expect((await prisma.toilet.findUniqueOrThrow({ where: { id: toilet.id } })).status).toBe('ACTIVE');
    });

    it('cron jobs need the secret, a session is not enough', async () => {
      const admin = await makeUser(prisma, `sec-admin-${id}`, { role: 'ADMIN' });
      await http().post('/admin/jobs/archive-status').set('Cookie', admin.cookie).expect(401);
      await http().post('/admin/jobs/archive-status').set('x-cron-secret', 'wrong').expect(401);
    });
  });

  // ───────────── request bodies ─────────────

  describe('request bodies', () => {
    it('compressed bodies are refused (415) before anything inflates them', async () => {
      const json = Buffer.from(JSON.stringify({ kind: 'NEW_TOILET', payload: {} }));
      for (const [encoding, body] of [
        ['br', brotliCompressSync(json)],
        ['gzip', gzipSync(json)],
        ['deflate', deflateSync(json)],
      ] as const) {
        await http()
          .post('/submissions')
          .set('Cookie', alice.cookie)
          .set('Content-Type', 'application/json')
          .set('Content-Encoding', encoding)
          .send(body)
          .expect(415);
      }
    });
  });
});
