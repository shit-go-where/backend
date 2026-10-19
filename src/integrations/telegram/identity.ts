/**
 * Who a Telegram chat is to the rest of the API (BOT.md §6, §10). Pure apart from crypto.
 *
 * - Contributions from an unlinked chat use `deviceIdFor(chatId)`: the bare hex HMAC from
 *   AnalyticsService.hashTelegramId (keyed on AUTH_SECRET), unprefixed, so the deviceId column
 *   stays unprefixed. Stable per chat, and cannot be reversed without the server secret.
 * - Analytics distinct id: the linked user's id, else `tg:<deviceId>`.
 * - Account linking (T15): a one-time 32-byte token, stored only as its SHA-256 hash.
 *
 * Only this file changes if the identity rule moves.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AnalyticsContext } from '../../analytics/analytics.js';

/** The bit of AnalyticsService this file needs (type only, so tests can pass a stub). */
export interface TelegramHasher {
  hashTelegramId(chatId: number | string): string;
}

/** Analytics context for everything the bot does (BOT.md §10). */
export const TELEGRAM: AnalyticsContext = { surface: 'telegram', source: 'telegram' };

/** Contribution device id for a chat: hashTelegramId(chatId), unprefixed. */
export function deviceIdFor(hasher: TelegramHasher, chatId: number | string | bigint): string {
  return hasher.hashTelegramId(String(chatId));
}

/** PostHog distinct id for the bot's own events: the linked user, else `tg:<hash>`. */
export function botDistinctId(deviceId: string, userId: string | null | undefined): string {
  return userId ? userId : `tg:${deviceId}`;
}

// ───────────────────────────── account linking ─────────────────────────────

export const LINK_TOKEN_TTL_MS = 10 * 60_000;
export const LINK_PAYLOAD_PREFIX = 'link_';
/** 32 random bytes in base64url: 43 characters, so `link_<token>` fits Telegram's 64-char start payload. */
const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const hashLinkToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** A fresh link token and the hash to store. The token itself is never stored. */
export function newLinkToken(now = new Date()): { token: string; hash: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashLinkToken(token), expiresAt: new Date(now.getTime() + LINK_TOKEN_TTL_MS) };
}

/** The token inside a `/start link_<token>` payload, or null when it is not one. */
export function parseLinkPayload(payload: string | undefined): string | null {
  if (!payload?.startsWith(LINK_PAYLOAD_PREFIX)) return null;
  const token = payload.slice(LINK_PAYLOAD_PREFIX.length);
  return LINK_TOKEN_RE.test(token) ? token : null;
}
