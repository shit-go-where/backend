import { createAnonToken, verifyAnonToken } from './anon.js';
import { DailyLimiter } from '../throttle.js';

describe('anonymous device cookie', () => {
  it('round-trips a signed random id', () => {
    const token = createAnonToken();
    const id = verifyAnonToken(token);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(token.startsWith(`${id}.`)).toBe(true);
  });

  it('rejects tampered, foreign or malformed values', () => {
    const token = createAnonToken('11111111-2222-4333-8444-555555555555');
    expect(verifyAnonToken(token.replace('1111', '9999'))).toBeNull();
    expect(verifyAnonToken(`${token}x`)).toBeNull();
    expect(verifyAnonToken('not-a-uuid.sig')).toBeNull();
    expect(verifyAnonToken(undefined)).toBeNull();
  });
});

describe('DailyLimiter', () => {
  it('caps each key per day and resets on a new day', () => {
    const l = new DailyLimiter(2);
    expect(l.take('ip', 1)).toBe(true);
    expect(l.take('ip', 1)).toBe(true);
    expect(l.take('ip', 1)).toBe(false);
    expect(l.take('other', 1)).toBe(true);
    expect(l.take('ip', 2)).toBe(true);
  });
});
