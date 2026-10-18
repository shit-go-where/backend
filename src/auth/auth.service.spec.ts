import { env } from '../config/env.js';
import {
  AuthService,
  OAUTH_STATE_TTL_MS,
  decodeStateCookie,
  encodeStateCookie,
  safeRedirect,
} from './auth.service.js';

describe('safeRedirect', () => {
  it.each([
    [undefined, '/'],
    ['', '/'],
    ['/', '/'],
    ['/toilets/abc?x=1#y', '/toilets/abc?x=1#y'],
    ['/me', '/me'],
  ])('accepts %s', (input, out) => expect(safeRedirect(input)).toBe(out));

  it.each([
    'https://evil.com',
    '//evil.com',
    '/\\evil.com',
    '/foo\\bar',
    'evil.com',
    'javascript:alert(1)',
    '/\nSet-Cookie',
    '/\t/evil.com',
    `/${'a'.repeat(600)}`,
  ])('rejects %s', (input) => expect(safeRedirect(input)).toBeNull());
});

describe('state cookie', () => {
  it('round-trips', () => {
    const c = encodeStateCookie('abc', '/x');
    expect(decodeStateCookie(c)).toEqual({ state: 'abc', redirect: '/x' });
  });
  it('rejects tampering', () => {
    const c = encodeStateCookie('abc', '/x');
    const [body, sig] = c.split('.');
    const forged = Buffer.from(JSON.stringify({ s: 'abc', r: '//evil.com', e: Date.now() + 1e6 }))
      .toString('base64url');
    expect(decodeStateCookie(`${forged}.${sig}`)).toBeNull();
    expect(decodeStateCookie(`${body}.${sig.slice(1)}x`)).toBeNull();
    expect(decodeStateCookie(undefined)).toBeNull();
  });
  it('expires', () => {
    const c = encodeStateCookie('abc', '/x', Date.now() - OAUTH_STATE_TTL_MS - 1);
    expect(decodeStateCookie(c)).toBeNull();
  });
});

describe('AuthService google flow', () => {
  const saved = { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, admins: env.ADMIN_EMAILS };
  beforeEach(() => {
    env.GOOGLE_CLIENT_ID = 'client-id';
    env.GOOGLE_CLIENT_SECRET = 'client-secret';
    env.ADMIN_EMAILS = ['boss@example.com'];
  });
  afterEach(() => {
    env.GOOGLE_CLIENT_ID = saved.id;
    env.GOOGLE_CLIENT_SECRET = saved.secret;
    env.ADMIN_EMAILS = saved.admins;
    vi.unstubAllGlobals();
  });

  function stubGoogle(profile: Record<string, unknown>, tokenOk = true) {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify(tokenOk ? { access_token: 'at' } : { error: 'bad' }), {
          status: tokenOk ? 200 : 400,
        });
      }
      if (u.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer at');
        return new Response(JSON.stringify(profile));
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('builds the Google URL with scope, state and redirect_uri', () => {
    const svc = new AuthService({} as never);
    const { url, cookie } = svc.beginGoogle('/after');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(u.searchParams.get('redirect_uri')).toBe(`${env.PUBLIC_APP_URL}/api/auth/callback`);
    expect(decodeStateCookie(cookie)).toEqual({ state: u.searchParams.get('state'), redirect: '/after' });
  });

  it('503s when not configured', () => {
    env.GOOGLE_CLIENT_ID = undefined;
    const svc = new AuthService({} as never);
    expect(() => svc.beginGoogle('/')).toThrow(/not configured/);
  });

  it('exchanges the code and returns a verified profile', async () => {
    const f = stubGoogle({ sub: 's1', email: 'A@Example.com', email_verified: true, name: 'A' });
    const svc = new AuthService({} as never);
    const p = await svc.exchangeCode('the-code');
    expect(p).toMatchObject({ sub: 's1', email: 'a@example.com', name: 'A' });
    const body = new URLSearchParams(f.mock.calls[0][1]?.body as string);
    expect(body.get('code')).toBe('the-code');
    expect(body.get('grant_type')).toBe('authorization_code');
  });

  it('rejects unverified email and failed token exchange', async () => {
    stubGoogle({ sub: 's1', email: 'a@example.com', email_verified: false });
    const svc = new AuthService({} as never);
    await expect(svc.exchangeCode('c')).rejects.toThrow(/not verified/);
    stubGoogle({}, false);
    await expect(svc.exchangeCode('c')).rejects.toThrow(/token exchange/);
  });

  it('upserts by googleSub, then email, and promotes ADMIN_EMAILS', async () => {
    const prisma = {
      user: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: object }) => ({ id: 'u1', ...data })),
        update: vi.fn(),
      },
    };
    const svc = new AuthService(prisma as never);
    const u = await svc.upsertGoogleUser({ sub: 's', email: 'boss@example.com', email_verified: true });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: 'ADMIN', displayName: 'boss', googleSub: 's' }),
    });
    expect(u.id).toBe('u1');

    prisma.user.findUnique
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: 'u2', role: 'USER', avatarUrl: null } as never);
    prisma.user.update.mockResolvedValue({ id: 'u2' } as never);
    await svc.upsertGoogleUser({ sub: 's2', email: 'x@example.com', email_verified: true, picture: 'p' });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u2' },
      data: { googleSub: 's2', email: 'x@example.com', avatarUrl: 'p' },
    });
  });
});
