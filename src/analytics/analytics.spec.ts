import { analyticsFromRequest, baseProps, distinctIdFor, hashTelegramId, roundDistance } from './analytics.js';

const req = (headers: Record<string, string>) => ({ headers });

describe('analytics helpers', () => {
  it('reads source and distinct id from headers, dropping malformed values', () => {
    expect(analyticsFromRequest(req({ 'x-sgw-source': 'Reddit', 'x-sgw-distinct-id': '0192abcd-ef' }))).toEqual({
      surface: 'web',
      source: 'reddit',
      distinctId: '0192abcd-ef',
    });
    expect(
      analyticsFromRequest(req({ 'x-sgw-source': '<script>', 'x-sgw-distinct-id': 'a b' })),
    ).toEqual({ surface: 'web', source: undefined, distinctId: undefined });
    expect(analyticsFromRequest(req({}))).toEqual({ surface: 'web', source: undefined, distinctId: undefined });
  });

  it('picks the distinct id: user, then telegram, then browser id, then device', () => {
    expect(distinctIdFor({ userId: 'u1', deviceId: 'd1' }, { surface: 'telegram' })).toBe('u1');
    expect(distinctIdFor({ deviceId: 'abc' }, { surface: 'telegram', distinctId: 'ph' })).toBe('tg:abc');
    expect(distinctIdFor({ deviceId: 'abc' }, { surface: 'web', distinctId: 'ph' })).toBe('ph');
    expect(distinctIdFor({ deviceId: 'abc' })).toBe('anon:abc');
    expect(distinctIdFor({})).toBe('anon:unknown');
  });

  it('base props carry surface, anonymity, source and extras', () => {
    expect(baseProps({ userId: 'u1' }, { surface: 'web', source: 'qr', extra: { after_route: true } })).toEqual({
      after_route: true,
      surface: 'web',
      anonymous: false,
      source: 'qr',
    });
    expect(baseProps({})).toEqual({ surface: 'web', anonymous: true });
  });

  it('hashes telegram chat ids stably, unprefixed, 32 hex chars, keyed on the secret', () => {
    const a = hashTelegramId(123456789, 'secret-one-16chars');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(hashTelegramId('123456789', 'secret-one-16chars')).toBe(a);
    expect(hashTelegramId(123456789, 'secret-two-16chars')).not.toBe(a);
  });

  it('rounds distances to 10 m', () => {
    expect(roundDistance(34)).toBe(30);
    expect(roundDistance(35)).toBe(40);
    expect(roundDistance(149)).toBe(150);
  });
});
