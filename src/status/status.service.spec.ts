import { extendedExpiry, ttlFor } from './status.service.js';

const H = 3_600_000;
const t0 = new Date('2026-10-18T00:00:00Z');
const at = (h: number) => new Date(t0.getTime() + h * H);

describe('status TTL rules', () => {
  it('TTL is 2h, CLOSED_NOW 24h', () => {
    expect(ttlFor('NO_PAPER')).toBe(2 * H);
    expect(ttlFor('CLOSED_NOW')).toBe(24 * H);
  });

  it('confirmation extends by 1h', () => {
    expect(extendedExpiry({ createdAt: t0, expiresAt: at(2) })).toEqual(at(3));
  });

  it('caps at createdAt + 6h', () => {
    expect(extendedExpiry({ createdAt: t0, expiresAt: at(5.5) })).toEqual(at(6));
    expect(extendedExpiry({ createdAt: t0, expiresAt: at(6) })).toEqual(at(6));
  });

  it('never shortens a longer TTL (CLOSED_NOW)', () => {
    expect(extendedExpiry({ createdAt: t0, expiresAt: at(24) })).toEqual(at(24));
  });
});
