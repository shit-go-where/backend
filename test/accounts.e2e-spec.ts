import request from 'supertest';
import {
  TEST_ADMIN_EMAIL,
  TEST_APP_URL,
  createAccountsApp,
  jpegBytes,
  login,
  makeToilet,
  uid,
} from './accounts-fixtures.js';

let ctx: Awaited<ReturnType<typeof createAccountsApp>>;
const email = (p: string) => `${p}-${uid()}@example.test`;
const cookiesOf = (res: request.Response) => ([] as string[]).concat(res.headers['set-cookie'] ?? []);

beforeAll(async () => {
  ctx = await createAccountsApp();
});
afterAll(async () => {
  await ctx?.app.close();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dev-login and /me', () => {
  it('signs in, returns Me and reads /me', async () => {
    const e = email('dev');
    const { cookie, me } = await login(ctx.server, e, 'Dev Person');
    expect(me).toMatchObject({
      email: e,
      displayName: 'Dev Person',
      handle: null,
      needsHandle: true,
      role: 'USER',
      points: 0,
      badges: [],
      leaderboardOptIn: false,
    });
    const res = await request(ctx.server).get('/me').set('Cookie', cookie).expect(200);
    expect(res.body.id).toBe(me.id);
  });

  it('401s when signed out', async () => {
    const res = await request(ctx.server).get('/me').expect(401);
    expect(res.body).toMatchObject({ statusCode: 401 });
  });

  it('gives ADMIN to ADMIN_EMAILS', async () => {
    const { me } = await login(ctx.server, TEST_ADMIN_EMAIL);
    expect(me.role).toBe('ADMIN');
  });

  it('404s when DEV_LOGIN_ENABLED is off', async () => {
    ctx.env.DEV_LOGIN_ENABLED = false;
    try {
      await request(ctx.server).post('/auth/dev-login').send({ email: email('x') }).expect(404);
    } finally {
      ctx.env.DEV_LOGIN_ENABLED = true;
    }
  });

  it('validates the body', async () => {
    const res = await request(ctx.server).post('/auth/dev-login').send({ email: 'nope' }).expect(400);
    expect(res.body.errors).toBeDefined();
  });

  it('logout clears the cookie', async () => {
    const res = await request(ctx.server).post('/auth/logout').expect(204);
    expect(cookiesOf(res).join(';')).toMatch(/sgw_session=;/);
  });
});

describe('PATCH /me', () => {
  it('sets handle, displayName and opt-in; 409 on taken or reserved handles', async () => {
    const a = await login(ctx.server, email('a'));
    const b = await login(ctx.server, email('b'));
    const handle = `h_${uid()}`;
    const res = await request(ctx.server)
      .patch('/me')
      .set('Cookie', a.cookie)
      .send({ handle: handle.toUpperCase(), displayName: 'Ann', leaderboardOptIn: true })
      .expect(200);
    expect(res.body).toMatchObject({ handle, displayName: 'Ann', leaderboardOptIn: true, needsHandle: false });

    await request(ctx.server).patch('/me').set('Cookie', a.cookie).send({ handle }).expect(200);
    await request(ctx.server).patch('/me').set('Cookie', b.cookie).send({ handle }).expect(409);
    await request(ctx.server).patch('/me').set('Cookie', b.cookie).send({ handle: 'admin' }).expect(409);
    await request(ctx.server).patch('/me').set('Cookie', b.cookie).send({ handle: 'no' }).expect(400);
    await request(ctx.server).patch('/me').set('Cookie', b.cookie).send({ displayName: '' }).expect(400);
  });
});

describe('Me extras (PLAN.md §12 E5/E6)', () => {
  it('reports trust progress, open submissions and unseen activity, and marks it seen', async () => {
    const { cookie, me } = await login(ctx.server, email('seen'));
    let res = await request(ctx.server).get('/me').set('Cookie', cookie).expect(200);
    expect(res.body).toMatchObject({
      trust: { score: 0, threshold: 50, isTrusted: false },
      openSubmissions: { count: 0, limit: 10 },
      unseen: { resolvedSubmissions: 0, badges: 0, points: 0, routed: 0 },
      lastSeenActivityAt: null,
      handleChangeableAt: null,
    });
    await ctx.prisma.pointsLedger.create({ data: { userId: me.id, reason: 'CHECK_IN', refId: `seen-${uid()}`, delta: 1 } });
    res = await request(ctx.server).get('/me').set('Cookie', cookie).expect(200);
    expect(res.body.unseen.points).toBe(1);

    const seen = await request(ctx.server).post('/me/activity/seen').set('Cookie', cookie).expect(200);
    expect(seen.body).toMatchObject({ ok: true, seenAt: expect.any(String) });
    res = await request(ctx.server).get('/me').set('Cookie', cookie).expect(200);
    expect(res.body.unseen).toEqual({ resolvedSubmissions: 0, badges: 0, points: 0, routed: 0 });
    expect(res.body.lastSeenActivityAt).toBe(seen.body.seenAt);
    await request(ctx.server).post('/me/activity/seen').expect(401);
  });

  it('lets a handle change once every 30 days; the first handle is free', async () => {
    const { cookie } = await login(ctx.server, email('hc'));
    const h = () => `h${uid()}`;
    await request(ctx.server).patch('/me').set('Cookie', cookie).send({ handle: h() }).expect(200);
    const changed = await request(ctx.server).patch('/me').set('Cookie', cookie).send({ handle: h() }).expect(200);
    expect(changed.body.handleChangeableAt).toEqual(expect.any(String));
    const again = await request(ctx.server).patch('/me').set('Cookie', cookie).send({ handle: h() }).expect(429);
    expect(again.body.message).toMatch(/once every 30 days/);
    // Same handle again, or other fields, are fine.
    await request(ctx.server).patch('/me').set('Cookie', cookie).send({ handle: changed.body.handle, displayName: 'X' }).expect(200);
  });
});

describe('anonymous check-ins merged on sign-in (PLAN.md §12 E4)', () => {
  it('banks points on the device, then pays them once on sign-in and clears the cookie', async () => {
    const { toilet } = await makeToilet(ctx.prisma);
    const at = { lat: toilet.latitude, lng: toilet.longitude };
    const first = await request(ctx.server).post(`/toilets/${toilet.id}/check-ins`).send(at).expect(201);
    expect(first.body).toMatchObject({ pointsAwarded: 0, bankedPoints: 4, confirmedPending: false, wentLive: false });
    const anon = cookiesOf(first).find((c) => c.startsWith('sgw_anon='))!;
    expect(anon).toMatch(/HttpOnly/i);
    expect(anon).toMatch(/SameSite=Lax/i);
    const anonCookie = anon.split(';')[0];
    const row = await ctx.prisma.checkIn.findUniqueOrThrow({ where: { id: first.body.id } });
    expect(row.userId).toBeNull();
    expect(row.deviceId).toEqual(expect.any(String));

    // Same device, same toilet within 2 h → 429.
    await request(ctx.server).post(`/toilets/${toilet.id}/check-ins`).set('Cookie', anonCookie).send(at).expect(429);
    // A signed-out status report from the same device.
    const report = await request(ctx.server)
      .post(`/toilets/${toilet.id}/status`)
      .set('Cookie', anonCookie)
      .send({ kind: 'CLOSED_NOW' })
      .expect(201);
    expect(report.body.unconfirmed).toBe(true);
    const ttl = new Date(report.body.expiresAt).getTime() - new Date(report.body.createdAt).getTime();
    expect(ttl).toBe(3_600_000);

    const e = email('merge');
    const signIn = await request(ctx.server).post('/auth/dev-login').set('Cookie', anonCookie).send({ email: e }).expect(200);
    expect(cookiesOf(signIn).some((c) => c.startsWith('sgw_anon=;'))).toBe(true);
    const merged = await ctx.prisma.checkIn.findUniqueOrThrow({ where: { id: first.body.id } });
    expect(merged.userId).toBe(signIn.body.id);
    expect(merged.deviceId).toBeNull();
    const rep = await ctx.prisma.statusReport.findUniqueOrThrow({ where: { id: report.body.id } });
    expect(rep.userId).toBe(signIn.body.id);
    const ledger = await ctx.prisma.pointsLedger.findMany({ where: { userId: signIn.body.id } });
    expect(ledger.map((l) => `${l.reason}:${l.delta}`).sort()).toEqual(['CHECK_IN:1', 'FIRST_CHECK_IN_AT_TOILET:3']);
    expect(ledger.find((l) => l.reason === 'CHECK_IN')!.createdAt.getTime()).toBe(row.createdAt.getTime());

    // Idempotent: signing in again with the old cookie pays nothing more.
    await request(ctx.server).post('/auth/dev-login').set('Cookie', anonCookie).send({ email: e }).expect(200);
    expect(await ctx.prisma.pointsLedger.count({ where: { userId: signIn.body.id } })).toBe(2);
  });

  it('applies the daily CHECK_IN cap per original Singapore day when merging', async () => {
    const { toilet } = await makeToilet(ctx.prisma);
    const deviceId = crypto.randomUUID();
    const day = new Date('2026-03-03T04:00:00Z');
    await ctx.prisma.checkIn.createMany({
      data: Array.from({ length: 7 }, (_, i) => ({
        deviceId,
        toiletId: toilet.id,
        distanceM: 10,
        createdAt: new Date(day.getTime() + i * 60_000),
      })),
    });
    const { createAnonToken } = await import('../src/common/auth/anon.js');
    const res = await request(ctx.server)
      .post('/auth/dev-login')
      .set('Cookie', `sgw_anon=${createAnonToken(deviceId)}`)
      .send({ email: email('cap') })
      .expect(200);
    const ledger = await ctx.prisma.pointsLedger.findMany({ where: { userId: res.body.id } });
    expect(ledger.filter((l) => l.reason === 'CHECK_IN')).toHaveLength(5);
    expect(ledger.filter((l) => l.reason === 'FIRST_CHECK_IN_AT_TOILET')).toHaveLength(1);
  });

  it('limits a device to 5 signed-out check-ins a day and sends pending toilets to sign-in', async () => {
    const { createAnonToken } = await import('../src/common/auth/anon.js');
    const cookie = `sgw_anon=${createAnonToken()}`;
    for (let i = 0; i < 5; i++) {
      const { toilet } = await makeToilet(ctx.prisma);
      await request(ctx.server)
        .post(`/toilets/${toilet.id}/check-ins`)
        .set('Cookie', cookie)
        .send({ lat: toilet.latitude, lng: toilet.longitude })
        .expect(201);
    }
    const { toilet } = await makeToilet(ctx.prisma);
    const res = await request(ctx.server)
      .post(`/toilets/${toilet.id}/check-ins`)
      .set('Cookie', cookie)
      .send({ lat: toilet.latitude, lng: toilet.longitude })
      .expect(429);
    expect(res.body.message).toMatch(/5 times a day/);

    const { toilet: pending } = await makeToilet(ctx.prisma, 'PENDING');
    const p = await request(ctx.server)
      .post(`/toilets/${pending.id}/check-ins`)
      .send({ lat: pending.latitude, lng: pending.longitude })
      .expect(401);
    expect(p.body.message).toMatch(/Sign in to confirm/);
  });
});

describe('GET /me/activity', () => {
  it('paginates the points ledger and Me.points sums it', async () => {
    const { cookie, me } = await login(ctx.server, email('act'));
    for (let i = 0; i < 3; i++) {
      await ctx.prisma.pointsLedger.create({
        data: {
          userId: me.id,
          delta: i + 1,
          reason: 'CHECK_IN',
          refId: `e2e-${i}`,
          createdAt: new Date(Date.now() - (3 - i) * 1000),
        },
      });
    }
    const p1 = await request(ctx.server).get('/me/activity?limit=2').set('Cookie', cookie).expect(200);
    expect(p1.body.items.map((x: { refId: string }) => x.refId)).toEqual(['e2e-2', 'e2e-1']);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await request(ctx.server)
      .get(`/me/activity?limit=2&cursor=${p1.body.nextCursor}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(p2.body.items.map((x: { refId: string }) => x.refId)).toEqual(['e2e-0']);
    expect(p2.body.nextCursor).toBeNull();
    const meRes = await request(ctx.server).get('/me').set('Cookie', cookie).expect(200);
    expect(meRes.body.points).toBe(6);
  });
});

describe('DELETE /me', () => {
  it('anonymises the user and removes personal rows', async () => {
    const e = email('del');
    const { cookie, me } = await login(ctx.server, e);
    const handle = `d_${uid()}`;
    await request(ctx.server).patch('/me').set('Cookie', cookie).send({ handle }).expect(200);
    const { toilet } = await makeToilet(ctx.prisma);
    const badgeId = `e2e-badge-${uid()}`;
    await ctx.prisma.badge.create({ data: { id: badgeId, name: 'B', description: 'd', icon: 'i', rule: {} } });
    await ctx.prisma.userBadge.create({ data: { userId: me.id, badgeId } });
    await ctx.prisma.checkIn.create({ data: { userId: me.id, toiletId: toilet.id, distanceM: 5 } });
    await ctx.prisma.pointsLedger.create({ data: { userId: me.id, delta: 1, reason: 'CHECK_IN', refId: 'x' } });
    const review = await ctx.prisma.review.create({ data: { toiletId: toilet.id, userId: me.id, cleanliness: 4 } });
    // Where they stood, what they wrote on votes and flags (PDPA: removed with the account).
    const sub = await ctx.prisma.submission.create({
      data: {
        kind: 'CLOSE_TOILET',
        toiletId: toilet.id,
        venueId: toilet.venueId,
        payload: { status: 'CLOSED', reason: 'gone' },
        submittedById: me.id,
        submittedLat: 1.3001,
        submittedLng: 103.8001,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const other = await login(ctx.server, email('del-other'));
    const theirs = await ctx.prisma.submission.create({
      data: {
        kind: 'CLOSE_TOILET',
        toiletId: toilet.id,
        venueId: toilet.venueId,
        payload: { status: 'CLOSED', reason: 'gone' },
        submittedById: other.me.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await ctx.prisma.submissionVote.create({
      data: { submissionId: theirs.id, userId: me.id, value: 'APPROVE', comment: 'I was here with my kid' },
    });
    const openFlag = await ctx.prisma.flag.create({ data: { toiletId: toilet.id, userId: me.id, reason: 'still open flag' } });
    const doneFlag = await ctx.prisma.flag.create({
      data: { toiletId: toilet.id, userId: me.id, reason: 'call me on 9123 4567', resolved: true },
    });

    const withBadge = await request(ctx.server).get('/me').set('Cookie', cookie).expect(200);
    expect(withBadge.body.badges).toEqual([expect.objectContaining({ id: badgeId, awardedAt: expect.any(String) })]);

    const res = await request(ctx.server).delete('/me').set('Cookie', cookie).expect(204);
    expect(cookiesOf(res).join(';')).toMatch(/sgw_session=;/);

    const u = await ctx.prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(u).toMatchObject({
      email: `deleted-${me.id}@deleted.invalid`,
      googleSub: null,
      handle: null,
      avatarUrl: null,
      displayName: 'Deleted user',
      leaderboardOptIn: false,
      role: 'USER',
    });
    expect(await ctx.prisma.checkIn.count({ where: { userId: me.id } })).toBe(0);
    expect(await ctx.prisma.pointsLedger.count({ where: { userId: me.id } })).toBe(0);
    expect(await ctx.prisma.userBadge.count({ where: { userId: me.id } })).toBe(0);
    expect(await ctx.prisma.review.findUnique({ where: { id: review.id } })).not.toBeNull();
    expect(u.deletedAt).toBeInstanceOf(Date);
    expect(await ctx.prisma.submission.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({
      submittedLat: null,
      submittedLng: null,
    });
    const vote = await ctx.prisma.submissionVote.findFirstOrThrow({ where: { submissionId: theirs.id, userId: me.id } });
    expect(vote).toMatchObject({ value: 'APPROVE', comment: null });
    expect((await ctx.prisma.flag.findUniqueOrThrow({ where: { id: openFlag.id } })).reason).toBe('still open flag');
    expect((await ctx.prisma.flag.findUniqueOrThrow({ where: { id: doneFlag.id } })).reason).toBe(
      'Removed: the reporter deleted their account',
    );

    // A cookie issued before deletion (e.g. on another device) no longer signs in.
    await request(ctx.server).get('/me').set('Cookie', cookie).expect(401);

    // The same email can sign up again as a fresh account.
    const again = await login(ctx.server, e);
    expect(again.me.id).not.toBe(me.id);
  });
});

describe('Google OAuth', () => {
  async function start(redirect = '/after?x=1') {
    const res = await request(ctx.server).get(`/auth/google?redirect=${encodeURIComponent(redirect)}`).expect(302);
    const loc = new URL(res.headers.location);
    const stateCookie = cookiesOf(res).find((c) => c.startsWith('sgw_oauth='))!;
    expect(stateCookie).toMatch(/HttpOnly/i);
    return { loc, cookie: stateCookie.split(';')[0], state: loc.searchParams.get('state')! };
  }

  function stubGoogle(profile: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.startsWith('https://oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'at', id_token: 'x' }));
        }
        if (u.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
          return new Response(JSON.stringify(profile));
        }
        throw new Error(`unexpected ${u}`);
      }),
    );
  }

  it('redirects to Google with state', async () => {
    const { loc, state } = await start();
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('redirect_uri')).toBe(`${TEST_APP_URL}/api/auth/callback`);
    expect(loc.searchParams.get('scope')).toBe('openid email profile');
    expect(state.length).toBeGreaterThan(20);
  });

  it('rejects open redirects', async () => {
    for (const r of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
      await request(ctx.server).get(`/auth/google?redirect=${encodeURIComponent(r)}`).expect(400);
    }
  });

  it('callback signs in, links by email and promotes admins', async () => {
    const sub = `sub-${uid()}`;
    stubGoogle({ sub, email: TEST_ADMIN_EMAIL, email_verified: true, name: 'Boss', picture: 'https://p/x.jpg' });
    const { cookie, state } = await start();
    const res = await request(ctx.server)
      .get(`/auth/callback?code=abc&state=${state}`)
      .set('Cookie', cookie)
      .expect(302);
    expect(res.headers.location).toBe(`${TEST_APP_URL}/after?x=1`);
    const session = cookiesOf(res).find((c) => c.startsWith('sgw_session='))!.split(';')[0];
    const me = await request(ctx.server).get('/me').set('Cookie', session).expect(200);
    expect(me.body).toMatchObject({ email: TEST_ADMIN_EMAIL, role: 'ADMIN', avatarUrl: 'https://p/x.jpg' });
    const u = await ctx.prisma.user.findUniqueOrThrow({ where: { email: TEST_ADMIN_EMAIL } });
    expect(u.googleSub).toBe(sub);
  });

  it('callback sends every failure to /login with a code', async () => {
    const login = (redirect: string, error: string) =>
      `${TEST_APP_URL}/login?${new URLSearchParams({ redirect, error }).toString()}`;
    const { cookie, state } = await start();
    let res = await request(ctx.server).get(`/auth/callback?code=abc&state=wrong`).set('Cookie', cookie).expect(302);
    expect(res.headers.location).toBe(login('/after?x=1', 'expired'));
    res = await request(ctx.server).get(`/auth/callback?code=abc&state=${state}`).expect(302);
    expect(res.headers.location).toBe(login('/', 'expired'));

    const s1 = await start('/go');
    res = await request(ctx.server)
      .get(`/auth/callback?error=access_denied&state=${s1.state}`)
      .set('Cookie', s1.cookie)
      .expect(302);
    expect(res.headers.location).toBe(login('/go', 'access_denied'));
    const s0 = await start('/go');
    res = await request(ctx.server).get(`/auth/callback?state=${s0.state}`).set('Cookie', s0.cookie).expect(302);
    expect(res.headers.location).toBe(login('/go', 'no_code'));

    stubGoogle({ sub: `s-${uid()}`, email: email('unv'), email_verified: false });
    const s2 = await start('/');
    res = await request(ctx.server)
      .get(`/auth/callback?code=abc&state=${s2.state}`)
      .set('Cookie', s2.cookie)
      .expect(302);
    expect(res.headers.location).toBe(login('/', 'email_unverified'));
    expect(cookiesOf(res).some((c) => c.startsWith('sgw_session=') && !c.startsWith('sgw_session=;'))).toBe(false);
  });

  it('503s when Google is not configured', async () => {
    const saved = ctx.env.GOOGLE_CLIENT_ID;
    ctx.env.GOOGLE_CLIENT_ID = undefined;
    try {
      const res = await request(ctx.server).get('/auth/google').expect(503);
      expect(res.body.message).toMatch(/not configured/);
    } finally {
      ctx.env.GOOGLE_CLIENT_ID = saved;
    }
  });
});

describe('media (local dev storage)', () => {
  it('presign → PUT upload → confirm → served file', async () => {
    const { cookie, me } = await login(ctx.server, email('media'));
    const img = await jpegBytes();
    const pre = await request(ctx.server)
      .post('/media/presign')
      .set('Cookie', cookie)
      .send({ contentType: 'image/jpeg', size: img.length })
      .expect(200);
    expect(pre.body).toEqual({
      photoId: expect.any(String),
      uploadUrl: `/api/media/${pre.body.photoId}/upload`,
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
    });
    const id = pre.body.photoId as string;
    const other = await login(ctx.server, email('media2'));

    await request(ctx.server).post(`/media/${id}/confirm`).set('Cookie', cookie).expect(400); // not uploaded
    await request(ctx.server)
      .put(`/media/${id}/upload`)
      .set('Cookie', other.cookie)
      .set('Content-Type', 'image/jpeg')
      .send(img)
      .expect(404);
    await request(ctx.server)
      .put(`/media/${id}/upload`)
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .send(img)
      .expect(415);
    await request(ctx.server)
      .put(`/media/${id}/upload`)
      .set('Cookie', cookie)
      .set('Content-Type', 'image/jpeg')
      .send(img)
      .expect(204);
    await request(ctx.server).post(`/media/${id}/confirm`).set('Cookie', other.cookie).expect(404);
    const conf = await request(ctx.server).post(`/media/${id}/confirm`).set('Cookie', cookie).expect(200);
    expect(conf.body).toEqual({
      id,
      url: `/api/media/files/photos/${id}.jpg`,
      thumbUrl: `/api/media/files/thumbs/${id}.webp`,
    });
    const row = await ctx.prisma.photo.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ confirmed: true, approved: false, uploadedById: me.id });

    const full = await request(ctx.server).get(`/media/files/photos/${id}.jpg`).expect(200);
    expect(full.headers['content-type']).toMatch(/image\/jpeg/);
    const thumb = await request(ctx.server).get(`/media/files/thumbs/${id}.webp`).expect(200);
    expect(thumb.headers['content-type']).toMatch(/image\/webp/);
    await request(ctx.server).get(`/media/files/tmp/${me.id}/${id}.jpg`).expect(404);
    await request(ctx.server).get(`/media/files/photos/..%2F..%2Fpackage.json`).expect(404);
  });

  it('rejects anonymous, oversize and unsupported presigns', async () => {
    await request(ctx.server).post('/media/presign').send({ contentType: 'image/jpeg', size: 10 }).expect(401);
    const { cookie } = await login(ctx.server, email('media3'));
    await request(ctx.server)
      .post('/media/presign')
      .set('Cookie', cookie)
      .send({ contentType: 'image/jpeg', size: 5_000_001 })
      .expect(400);
    await request(ctx.server)
      .post('/media/presign')
      .set('Cookie', cookie)
      .send({ contentType: 'image/gif', size: 10 })
      .expect(400);
  });

  it('confirm rejects files that are not the declared image type', async () => {
    const { cookie } = await login(ctx.server, email('media4'));
    const pre = await request(ctx.server)
      .post('/media/presign')
      .set('Cookie', cookie)
      .send({ contentType: 'image/png', size: 100 })
      .expect(200);
    await request(ctx.server)
      .put(`/media/${pre.body.photoId}/upload`)
      .set('Cookie', cookie)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('definitely not a png'))
      .expect(204);
    const res = await request(ctx.server).post(`/media/${pre.body.photoId}/confirm`).set('Cookie', cookie).expect(400);
    expect(res.body.message).toMatch(/not a valid image/);
  });

  it('confirm returns 400 (not 500) for a truncated image with a valid header', async () => {
    const { cookie } = await login(ctx.server, email('media5'));
    const sharp = (await import('sharp')).default;
    const good = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#8a5a2b' } })
      .jpeg({ progressive: true })
      .toBuffer();
    const truncated = good.subarray(0, Math.floor(good.length * 0.6));
    const pre = await request(ctx.server)
      .post('/media/presign')
      .set('Cookie', cookie)
      .send({ contentType: 'image/jpeg', size: truncated.length })
      .expect(200);
    await request(ctx.server)
      .put(`/media/${pre.body.photoId}/upload`)
      .set('Cookie', cookie)
      .set('Content-Type', 'image/jpeg')
      .send(truncated)
      .expect(204);
    const res = await request(ctx.server).post(`/media/${pre.body.photoId}/confirm`).set('Cookie', cookie);
    expect(res.status).toBe(400);
  });
});
