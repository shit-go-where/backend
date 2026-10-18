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

  it('callback rejects bad state and unverified email', async () => {
    const { cookie, state } = await start();
    await request(ctx.server).get(`/auth/callback?code=abc&state=wrong`).set('Cookie', cookie).expect(400);
    await request(ctx.server).get(`/auth/callback?code=abc&state=${state}`).expect(400);

    stubGoogle({ sub: `s-${uid()}`, email: email('unv'), email_verified: false });
    const s2 = await start('/');
    const res = await request(ctx.server)
      .get(`/auth/callback?code=abc&state=${s2.state}`)
      .set('Cookie', s2.cookie)
      .expect(302);
    expect(res.headers.location).toBe(`${TEST_APP_URL}/?authError=email_unverified`);
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
