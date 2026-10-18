import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { env } from '../config/env.js';
import { CronSecretGuard, secretMatches } from './cron-secret.guard.js';

const ctx = (headers: Record<string, string>) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as never;

describe('CronSecretGuard', () => {
  const saved = env.CRON_SECRET;
  afterEach(() => {
    env.CRON_SECRET = saved;
  });

  it('compares secrets of any length', () => {
    expect(secretMatches('abc', 'abc')).toBe(true);
    expect(secretMatches('abd', 'abc')).toBe(false);
    expect(secretMatches('abcd', 'abc')).toBe(false);
    expect(secretMatches('', 'abc')).toBe(false);
    expect(secretMatches(undefined, 'abc')).toBe(false);
  });

  it('503 when unset, 401 on mismatch, passes on match', () => {
    const g = new CronSecretGuard();
    env.CRON_SECRET = undefined;
    expect(() => g.canActivate(ctx({ 'x-cron-secret': 'x' }))).toThrow(ServiceUnavailableException);
    env.CRON_SECRET = 's3cret';
    expect(() => g.canActivate(ctx({}))).toThrow(UnauthorizedException);
    expect(() => g.canActivate(ctx({ 'x-cron-secret': 'nope' }))).toThrow(UnauthorizedException);
    expect(g.canActivate(ctx({ 'x-cron-secret': 's3cret' }))).toBe(true);
  });
});
