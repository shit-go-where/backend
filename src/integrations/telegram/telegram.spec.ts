import { CHAT_LIMITS, ChatLimiter, botInfoFor, updateKind } from './telegram.service.js';
import { TOUCH_INTERVAL_MS, URGENT_WINDOW_MS, chatTypeOf, filterStateOf, isUrgent, needsTouch } from './chats.service.js';
import { CHECKIN_TTL_MS, checkInExpired, minuteOf, shouldNudge } from './format.js';
import { webhookUrl } from './commands.js';

const NOW = new Date('2026-10-20T04:00:00Z');

describe('urgent mode (T4)', () => {
  it('lasts two minutes after /go', () => {
    expect(isUrgent({ urgentUntil: null }, NOW)).toBe(false);
    expect(isUrgent({ urgentUntil: new Date(NOW.getTime() + URGENT_WINDOW_MS) }, NOW)).toBe(true);
    expect(isUrgent({ urgentUntil: new Date(NOW.getTime() - 1) }, NOW)).toBe(false);
    expect(URGENT_WINDOW_MS).toBe(120_000);
  });
});

describe('check-in freshness (T6)', () => {
  it('accepts a tap within 10 minutes of the shared location', () => {
    const minute = minuteOf(NOW);
    expect(checkInExpired(minute, NOW)).toBe(false);
    expect(checkInExpired(minute, new Date(NOW.getTime() + CHECKIN_TTL_MS))).toBe(false);
    expect(checkInExpired(minute, new Date(NOW.getTime() + CHECKIN_TTL_MS + 60_001))).toBe(true);
  });
});

describe('chat rows', () => {
  it('maps Telegram chat types', () => {
    expect(chatTypeOf('private')).toBe('PRIVATE');
    expect(chatTypeOf('group')).toBe('GROUP');
    expect(chatTypeOf('supergroup')).toBe('SUPERGROUP');
    expect(chatTypeOf('channel')).toBe('CHANNEL');
  });

  it('writes lastSeenAt at most once an hour', () => {
    expect(needsTouch(new Date(NOW.getTime() - TOUCH_INTERVAL_MS + 1), NOW)).toBe(false);
    expect(needsTouch(new Date(NOW.getTime() - TOUCH_INTERVAL_MS), NOW)).toBe(true);
  });

  it('reads the saved filters', () => {
    expect(filterStateOf({ filters: ['BIDET'], areaType: 'UNPAID_AREA', openNow: true })).toEqual({
      filters: ['BIDET'],
      areaType: 'UNPAID_AREA',
      openNow: true,
    });
  });
});

describe('nudge (GROWTH 3.3)', () => {
  it('after the 3rd contribution, then every 5th', () => {
    expect([1, 2, 3, 4, 5, 6, 10, 11, 15].map(shouldNudge)).toEqual([
      false,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
  });
});

describe('ChatLimiter', () => {
  it('allows the per-minute budget, tells the chat once, then resets next minute', () => {
    const l = new ChatLimiter(3, 100);
    const t = NOW;
    expect([1, 2, 3].map(() => l.take('42', t).ok)).toEqual([true, true, true]);
    expect(l.take('42', t)).toEqual({ ok: false, reason: 'minute', notify: true });
    expect(l.take('42', t)).toEqual({ ok: false, reason: 'minute', notify: false });
    // Another chat is unaffected.
    expect(l.take('43', t).ok).toBe(true);
    expect(l.take('42', new Date(t.getTime() + 60_000)).ok).toBe(true);
  });

  it('caps the Singapore day', () => {
    const l = new ChatLimiter(100, 2);
    expect(l.take('1', NOW).ok).toBe(true);
    expect(l.take('1', new Date(NOW.getTime() + 60_000)).ok).toBe(true);
    expect(l.take('1', new Date(NOW.getTime() + 120_000))).toEqual({ ok: false, reason: 'day', notify: true });
    // 16:00 UTC is midnight in Singapore.
    expect(l.take('1', new Date('2026-10-20T16:00:00Z')).ok).toBe(true);
  });

  it('uses the BOT.md numbers', () => {
    expect(CHAT_LIMITS).toEqual({ private: { perMinute: 20, perDay: 300 }, group: { perMinute: 10, perDay: 200 } });
  });
});

describe('bot setup', () => {
  it('derives the bot identity from the token without getMe', () => {
    const me = botInfoFor('123456:secret-part', '@testbot');
    expect(me).toMatchObject({ id: 123456, is_bot: true, username: 'testbot', can_join_groups: true });
    expect(() => botInfoFor('nonsense', 'testbot')).toThrow();
  });

  it('logs update kinds, never their content', () => {
    expect(updateKind({ update_id: 1, message: { text: 'secret' } })).toBe('message');
    expect(updateKind({ update_id: 1 })).toBe('unknown');
  });

  it('webhook URL goes through the app origin /api rewrite unless an API origin is given', () => {
    expect(webhookUrl('https://app.example/')).toBe('https://app.example/api/integrations/telegram');
    expect(webhookUrl('https://app.example', 'https://api.example/')).toBe('https://api.example/integrations/telegram');
  });
});
