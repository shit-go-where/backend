import { existsSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import {
  TEST_ADMIN_EMAIL,
  TEST_CRON_SECRET,
  createAccountsApp,
  jpegBytes,
  login,
  makeToilet,
  uid,
} from './accounts-fixtures.js';

let ctx: Awaited<ReturnType<typeof createAccountsApp>>;
type Session = Awaited<ReturnType<typeof login>>;
let admin: Session, mod: Session, trustedA: Session, trustedB: Session, user: Session;

const email = (p: string) => `${p}-${uid()}@example.test`;

async function loginAs(role: 'USER' | 'TRUSTED' | 'MODERATOR'): Promise<Session> {
  const s = await login(ctx.server, email(role.toLowerCase()));
  if (role !== 'USER') await ctx.prisma.user.update({ where: { id: s.me.id }, data: { role } });
  return s;
}

async function confirmedPhoto(uploadedById: string, toiletId?: string) {
  const id = `e2e-${uid()}`;
  return ctx.prisma.photo.create({
    data: {
      id,
      key: `photos/${id}.jpg`,
      url: `/api/media/photos/${id}`,
      thumbUrl: `/api/media/photos/${id}/thumb`,
      contentType: 'image/jpeg',
      uploadedById,
      toiletId,
      confirmed: true,
    },
  });
}

beforeAll(async () => {
  ctx = await createAccountsApp();
  admin = await login(ctx.server, TEST_ADMIN_EMAIL);
  mod = await loginAs('MODERATOR');
  trustedA = await loginAs('TRUSTED');
  trustedB = await loginAs('TRUSTED');
  user = await loginAs('USER');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('role checks', () => {
  it('401 signed out, 403 for USER/TRUSTED on MODERATOR routes', async () => {
    await request(ctx.server).get('/admin/flags').expect(401);
    await request(ctx.server).get('/admin/flags').set('Cookie', user.cookie).expect(403);
    await request(ctx.server).get('/admin/flags').set('Cookie', trustedA.cookie).expect(403);
    await request(ctx.server).get('/admin/flags').set('Cookie', mod.cookie).expect(200);
    await request(ctx.server).get('/admin/photos/pending').set('Cookie', user.cookie).expect(403);
    await request(ctx.server).get('/admin/photos/pending').set('Cookie', trustedA.cookie).expect(200);
  });
});

describe('flags', () => {
  it('lists open flags and resolves them', async () => {
    const { toilet, venue } = await makeToilet(ctx.prisma);
    const flag = await ctx.prisma.flag.create({
      data: { toiletId: toilet.id, userId: user.me.id, reason: 'Door broken' },
    });
    const open = await request(ctx.server).get('/admin/flags').set('Cookie', mod.cookie).expect(200);
    expect(open.body.items).toContainEqual(
      expect.objectContaining({
        id: flag.id,
        reason: 'Door broken',
        toilet: { id: toilet.id, label: toilet.label, venueName: venue.name },
        user: { handle: null },
      }),
    );
    await request(ctx.server).post(`/admin/flags/${flag.id}/resolve`).set('Cookie', mod.cookie).expect(200, { ok: true });
    await request(ctx.server).post(`/admin/flags/nope/resolve`).set('Cookie', mod.cookie).expect(404);
    const after = await request(ctx.server).get('/admin/flags').set('Cookie', mod.cookie).expect(200);
    expect(after.body.items.map((f: { id: string }) => f.id)).not.toContain(flag.id);
    const resolved = await request(ctx.server).get('/admin/flags?resolved=true').set('Cookie', mod.cookie).expect(200);
    expect(resolved.body.items.map((f: { id: string }) => f.id)).toContain(flag.id);
  });
});

describe('photo moderation', () => {
  it('2 TRUSTED approvals publish; same user cannot approve twice', async () => {
    const p = await confirmedPhoto(user.me.id);
    const pending = await request(ctx.server).get('/admin/photos/pending').set('Cookie', trustedA.cookie).expect(200);
    expect(pending.body.items).toContainEqual(
      expect.objectContaining({ id: p.id, approvals: 0, toiletId: null, createdAt: expect.any(String) }),
    );
    await request(ctx.server)
      .post(`/admin/photos/${p.id}/approve`)
      .set('Cookie', trustedA.cookie)
      .expect(200, { approved: false, approvals: 1 });
    await request(ctx.server).post(`/admin/photos/${p.id}/approve`).set('Cookie', trustedA.cookie).expect(409);
    await request(ctx.server)
      .post(`/admin/photos/${p.id}/approve`)
      .set('Cookie', trustedB.cookie)
      .expect(200, { approved: true, approvals: 2 });
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: p.id } })).approved).toBe(true);
    expect(await ctx.prisma.photoApproval.count({ where: { photoId: p.id } })).toBe(2);
  });

  it('1 MODERATOR approval publishes; USER cannot approve; uploader cannot self-approve', async () => {
    const p = await confirmedPhoto(trustedA.me.id);
    await request(ctx.server).post(`/admin/photos/${p.id}/approve`).set('Cookie', user.cookie).expect(403);
    await request(ctx.server).post(`/admin/photos/${p.id}/approve`).set('Cookie', trustedA.cookie).expect(403);
    await request(ctx.server)
      .post(`/admin/photos/${p.id}/approve`)
      .set('Cookie', mod.cookie)
      .expect(200, { approved: true, approvals: 1 });
    await request(ctx.server).post(`/admin/photos/missing/approve`).set('Cookie', mod.cookie).expect(404);
  });

  it('reject (MODERATOR+) deletes the stored objects and the row', async () => {
    const img = await jpegBytes(200, 100);
    const pre = await request(ctx.server)
      .post('/media/presign')
      .set('Cookie', user.cookie)
      .send({ contentType: 'image/jpeg', size: img.length })
      .expect(200);
    const id = pre.body.photoId as string;
    await request(ctx.server)
      .put(`/media/${id}/upload`)
      .set('Cookie', user.cookie)
      .set('Content-Type', 'image/jpeg')
      .send(img)
      .expect(204);
    await request(ctx.server).post(`/media/${id}/confirm`).set('Cookie', user.cookie).expect(200);
    const file = join(process.cwd(), 'uploads', 'photos', `${id}.jpg`);
    const thumb = join(process.cwd(), 'uploads', 'thumbs', `${id}.webp`);
    expect(existsSync(file) && existsSync(thumb)).toBe(true);

    await request(ctx.server).post(`/admin/photos/${id}/reject`).set('Cookie', trustedA.cookie).expect(403);
    await request(ctx.server).post(`/admin/photos/${id}/reject`).set('Cookie', mod.cookie).expect(200, { ok: true });
    expect(existsSync(file) || existsSync(thumb)).toBe(false);
    expect(await ctx.prisma.photo.findUnique({ where: { id } })).toBeNull();
  });
});

describe('PATCH /admin/toilets/:id', () => {
  it('updates fields and writes ADMIN-sourced features', async () => {
    const { toilet } = await makeToilet(ctx.prisma);
    await ctx.prisma.toiletFeature.create({
      data: { toiletId: toilet.id, feature: 'BIDET', present: true, source: 'OSM', observedAt: new Date(0) },
    });
    await request(ctx.server)
      .patch(`/admin/toilets/${toilet.id}`)
      .set('Cookie', mod.cookie)
      .send({
        status: 'RENOVATION',
        label: 'Near Exit A',
        areaType: 'UNPAID_AREA',
        level: 'basement 1',
        accessNote: null,
        needsResurvey: true,
        features: { BIDET: false, ACCESSIBLE: true },
      })
      .expect(200, { id: toilet.id });
    const t = await ctx.prisma.toilet.findUniqueOrThrow({ where: { id: toilet.id }, include: { features: true } });
    expect(t).toMatchObject({ status: 'RENOVATION', label: 'Near Exit A', areaType: 'UNPAID_AREA', level: 'B1', levelOrder: -1, needsResurvey: true });
    const byF = Object.fromEntries(t.features.map((f) => [f.feature, f]));
    expect(byF.BIDET).toMatchObject({ present: false, source: 'ADMIN' });
    expect(byF.ACCESSIBLE).toMatchObject({ present: true, source: 'ADMIN' });
    expect(byF.BIDET.observedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    await request(ctx.server).patch(`/admin/toilets/${toilet.id}`).set('Cookie', mod.cookie).send({ features: { NOPE: true } }).expect(400);
    await request(ctx.server).patch(`/admin/toilets/missing`).set('Cookie', mod.cookie).send({ label: 'x' }).expect(404);
    await request(ctx.server).patch(`/admin/toilets/${toilet.id}`).set('Cookie', trustedA.cookie).send({ label: 'x' }).expect(403);
  });
});

describe('PATCH /admin/users/:id/role', () => {
  it('ADMIN only; cannot change own role', async () => {
    const target = await loginAs('USER');
    await request(ctx.server).patch(`/admin/users/${target.me.id}/role`).set('Cookie', mod.cookie).send({ role: 'TRUSTED' }).expect(403);
    await request(ctx.server)
      .patch(`/admin/users/${target.me.id}/role`)
      .set('Cookie', admin.cookie)
      .send({ role: 'MODERATOR' })
      .expect(200, { id: target.me.id, role: 'MODERATOR' });
    await request(ctx.server).patch(`/admin/users/${admin.me.id}/role`).set('Cookie', admin.cookie).send({ role: 'USER' }).expect(400);
    await request(ctx.server).patch(`/admin/users/missing/role`).set('Cookie', admin.cookie).send({ role: 'USER' }).expect(404);
    await request(ctx.server).patch(`/admin/users/${target.me.id}/role`).set('Cookie', admin.cookie).send({ role: 'GOD' }).expect(400);
  });
});

describe('imports and data quality', () => {
  it('lists import runs', async () => {
    const run = await ctx.prisma.importRun.create({
      data: { source: 'OSM', command: `e2e ${uid()}`, inserted: 3, log: { note: 'hi' } },
    });
    const res = await request(ctx.server).get('/admin/imports').set('Cookie', mod.cookie).expect(200);
    expect(res.body.items).toContainEqual(
      expect.objectContaining({ id: run.id, source: 'OSM', inserted: 3, finishedAt: null, log: { note: 'hi' } }),
    );
  });

  it('returns counts', async () => {
    const res = await request(ctx.server).get('/admin/data-quality').set('Cookie', mod.cookie).expect(200);
    const keys = ['toilets', 'venues', 'pending', 'escalated', 'flagsOpen', 'photosPending', 'noFeatures', 'stale365d', 'needsResurvey', 'unknownAreaType'];
    expect(Object.keys(res.body.counts).sort()).toEqual([...keys].sort());
    for (const k of keys) expect(Number.isInteger(res.body.counts[k])).toBe(true);
    expect(res.body.counts.toilets).toBeGreaterThan(0);
  });
});

describe('POST /admin/jobs/:name', () => {
  const job = (name: string, secret?: string) => {
    const r = request(ctx.server).post(`/admin/jobs/${name}`);
    return secret === undefined ? r : r.set('x-cron-secret', secret);
  };

  it('401 without/with wrong secret (session alone is not enough), 404 unknown job', async () => {
    await job('archive-status').expect(401);
    await job('archive-status').set('Cookie', admin.cookie).expect(401);
    await job('archive-status', 'wrong').expect(401);
    await job('nope', TEST_CRON_SECRET).expect(404);
  });

  it('503 when CRON_SECRET is unset', async () => {
    const saved = ctx.env.CRON_SECRET;
    ctx.env.CRON_SECRET = undefined;
    try {
      await job('archive-status', 'x').expect(503);
    } finally {
      ctx.env.CRON_SECRET = saved;
    }
  });

  it('skips the throttler', async () => {
    for (let i = 0; i < 130; i++) await job('nope', TEST_CRON_SECRET).expect(404);
  });

  it('expire-submissions escalates due submissions to moderators and keeps their toilets pending', async () => {
    const { toilet } = await makeToilet(ctx.prisma, 'PENDING');
    const { toilet: liveToilet } = await makeToilet(ctx.prisma, 'PENDING');
    const past = new Date(Date.now() - 1000);
    const due = await ctx.prisma.submission.create({
      data: { kind: 'NEW_TOILET', toiletId: toilet.id, payload: {}, submittedById: user.me.id, expiresAt: past },
    });
    const info = await ctx.prisma.submission.create({
      data: { kind: 'EDIT_TOILET', state: 'NEEDS_INFO', payload: {}, submittedById: user.me.id, expiresAt: past },
    });
    const notDue = await ctx.prisma.submission.create({
      data: {
        kind: 'NEW_TOILET',
        toiletId: liveToilet.id,
        payload: {},
        submittedById: user.me.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const res = await job('expire-submissions', TEST_CRON_SECRET).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.affected).toBeGreaterThanOrEqual(2);
    const states = await ctx.prisma.submission.findMany({ where: { id: { in: [due.id, info.id, notDue.id] } } });
    const byId = Object.fromEntries(states.map((s) => [s.id, s]));
    expect(byId[due.id]).toMatchObject({ state: 'ESCALATED', resolution: 'escalated_expired', resolvedAt: null });
    expect(byId[due.id].escalatedAt).not.toBeNull();
    expect(byId[info.id].state).toBe('ESCALATED');
    expect(byId[notDue.id].state).toBe('PENDING');
    expect((await ctx.prisma.toilet.findUniqueOrThrow({ where: { id: toilet.id } })).status).toBe('PENDING');
    expect((await ctx.prisma.toilet.findUniqueOrThrow({ where: { id: liveToilet.id } })).status).toBe('PENDING');
  });

  it('archive-status deletes reports expired more than 7 days ago', async () => {
    const { toilet } = await makeToilet(ctx.prisma);
    const day = 86_400_000;
    const old = await ctx.prisma.statusReport.create({
      data: { toiletId: toilet.id, userId: user.me.id, kind: 'NO_PAPER', createdAt: new Date(Date.now() - 9 * day), expiresAt: new Date(Date.now() - 8 * day) },
    });
    const recent = await ctx.prisma.statusReport.create({
      data: { toiletId: toilet.id, userId: user.me.id, kind: 'NO_SOAP', createdAt: new Date(Date.now() - 2 * day), expiresAt: new Date(Date.now() - day) },
    });
    const res = await job('archive-status', TEST_CRON_SECRET).expect(200);
    expect(res.body.affected).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.statusReport.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await ctx.prisma.statusReport.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });

  it('recompute-scores recomputes every toilet', async () => {
    const { toilet } = await makeToilet(ctx.prisma);
    await ctx.prisma.review.create({ data: { toiletId: toilet.id, userId: user.me.id, cleanliness: 5 } });
    const res = await job('recompute-scores', TEST_CRON_SECRET).expect(200);
    expect(res.body.affected).toBeGreaterThan(0);
    const t = await ctx.prisma.toilet.findUniqueOrThrow({ where: { id: toilet.id } });
    expect(t).toMatchObject({ reviewCount: 1, scoreCleanliness: 10 });
  }, 60_000);
});
