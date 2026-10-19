import { hashTelegramId } from '../../analytics/analytics.js';
import {
  LINK_TOKEN_TTL_MS,
  botDistinctId,
  deviceIdFor,
  hashLinkToken,
  newLinkToken,
  parseLinkPayload,
} from './identity.js';

const SECRET = 'unit-test-secret-at-least-16';
const hasher = { hashTelegramId: (id: number | string) => hashTelegramId(id, SECRET) };

describe('deviceIdFor', () => {
  it('is the unprefixed 32-char hashTelegramId of the chat id', () => {
    const id = deviceIdFor(hasher, 123456789);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).toBe(hashTelegramId('123456789', SECRET));
    expect(deviceIdFor(hasher, 123456789n)).toBe(id);
    expect(deviceIdFor(hasher, -100123)).not.toBe(id);
  });

  it('cannot be computed without the secret', () => {
    expect(hashTelegramId(123456789, 'another-secret-entirely')).not.toBe(deviceIdFor(hasher, 123456789));
  });
});

describe('botDistinctId', () => {
  it('uses the linked user, else tg:<hash>', () => {
    expect(botDistinctId('abc', 'user1')).toBe('user1');
    expect(botDistinctId('abc', null)).toBe('tg:abc');
  });
});

describe('link tokens', () => {
  it('makes a 43-char token whose sha256 is stored, valid 10 minutes', () => {
    const now = new Date('2026-10-20T00:00:00Z');
    const t = newLinkToken(now);
    expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.hash).toBe(hashLinkToken(t.token));
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.expiresAt.getTime() - now.getTime()).toBe(LINK_TOKEN_TTL_MS);
    expect(newLinkToken(now).token).not.toBe(t.token);
    // link_<token> fits Telegram's 64-character start payload.
    expect(`link_${t.token}`.length).toBeLessThanOrEqual(64);
  });

  it('parses only well-formed link payloads', () => {
    const { token } = newLinkToken();
    expect(parseLinkPayload(`link_${token}`)).toBe(token);
    expect(parseLinkPayload(token)).toBeNull();
    expect(parseLinkPayload('link_short')).toBeNull();
    expect(parseLinkPayload('go')).toBeNull();
    expect(parseLinkPayload(undefined)).toBeNull();
  });
});
