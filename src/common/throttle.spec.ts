import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createSessionToken } from './auth/session.js';
import { SkipThrottle, Throttle, ThrottleGuard, trackerFor, DEFAULT_LIMIT } from './throttle.js';

class Ctl {
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  tight() {}
  @SkipThrottle()
  free() {}
  normal() {}
}

function ctx(handler: keyof Ctl, req: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
  const c = {
    getType: () => 'http',
    getHandler: () => Ctl.prototype[handler],
    getClass: () => Ctl,
    switchToHttp: () => ({ getRequest: () => ({ headers: {}, cookies: {}, ...req }), getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { c, headers };
}

describe('ThrottleGuard', () => {
  let guard: ThrottleGuard;
  beforeEach(() => (guard = new ThrottleGuard(new Reflector())));

  it('allows up to the route limit then returns 429 with Retry-After', () => {
    const req = { ip: '1.1.1.1' };
    expect(guard.canActivate(ctx('tight', req).c)).toBe(true);
    expect(guard.canActivate(ctx('tight', req).c)).toBe(true);
    const third = ctx('tight', req);
    let err: unknown;
    try {
      guard.canActivate(third.c);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(Number(third.headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('counts separately per client and per route', () => {
    for (let i = 0; i < 2; i++) guard.canActivate(ctx('tight', { ip: '1.1.1.1' }).c);
    expect(guard.canActivate(ctx('tight', { ip: '2.2.2.2' }).c)).toBe(true);
    expect(guard.canActivate(ctx('normal', { ip: '1.1.1.1' }).c)).toBe(true);
  });

  it('skips routes marked @SkipThrottle', () => {
    for (let i = 0; i < 500; i++) expect(guard.canActivate(ctx('free', { ip: '1.1.1.1' }).c)).toBe(true);
  });

  it('uses the default limit when no override is set', () => {
    const { c, headers } = ctx('normal', { ip: '3.3.3.3' });
    guard.canActivate(c);
    expect(headers['X-RateLimit-Limit']).toBe(String(DEFAULT_LIMIT.limit));
  });
});

describe('trackerFor', () => {
  it('keys signed-in users by id, not IP', () => {
    const token = createSessionToken('user123');
    expect(trackerFor({ cookies: { sgw_session: token }, headers: {}, ip: '9.9.9.9' } as never)).toBe('u:user123');
  });

  it('falls back to x-real-ip, then the first x-forwarded-for, then req.ip', () => {
    expect(trackerFor({ headers: { 'x-real-ip': '5.5.5.5' }, ip: '9.9.9.9' } as never)).toBe('ip:5.5.5.5');
    expect(trackerFor({ headers: { 'x-forwarded-for': '6.6.6.6, 10.0.0.1' }, ip: '9.9.9.9' } as never)).toBe('ip:6.6.6.6');
    expect(trackerFor({ headers: {}, ip: '9.9.9.9' } as never)).toBe('ip:9.9.9.9');
  });

  it('ignores a forged session cookie', () => {
    expect(trackerFor({ cookies: { sgw_session: 'abc.def' }, headers: {}, ip: '9.9.9.9' } as never)).toBe('ip:9.9.9.9');
  });
});
