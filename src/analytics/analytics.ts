import { createHmac } from 'node:crypto';
import type { Request } from 'express';

/**
 * Product analytics contract (GROWTH.md 0.1, shared with the Telegram bot, BOT.md §10).
 * Pure helpers and types; the PostHog client lives in AnalyticsService.
 */

export const ANALYTICS_EVENTS = [
  'route_started',
  'route_completed',
  'checkin',
  'status_report',
  'review',
  'submission',
  'vote',
  'share',
  'install_prompt',
  'signin',
] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export type AnalyticsSurface = 'web' | 'telegram';

/**
 * Where a contribution came from. Services take it as an optional trailing argument and default
 * to the web. `distinctId` is the browser's PostHog id (header `x-sgw-distinct-id`), so server
 * events join the visitor's client-side funnel; signed-in users always use their user id.
 */
export interface AnalyticsContext {
  surface: AnalyticsSurface;
  /** utm_source of the visit (first touch), e.g. "reddit", "telegram", "qr". */
  source?: string;
  distinctId?: string;
  /** Extra event properties the caller knows and the service does not, e.g. { after_route: true }. */
  extra?: Record<string, string | number | boolean>;
}

export const WEB: AnalyticsContext = { surface: 'web' };

const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DISTINCT_RE = /^[A-Za-z0-9$:._-]{1,100}$/;

function header(req: Pick<Request, 'headers'>, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

/** Web context from request headers. Malformed values are dropped, never trusted. */
export function analyticsFromRequest(req: Pick<Request, 'headers'>): AnalyticsContext {
  const source = header(req, 'x-sgw-source')?.toLowerCase();
  const distinctId = header(req, 'x-sgw-distinct-id');
  return {
    surface: 'web',
    source: source && SOURCE_RE.test(source) ? source : undefined,
    distinctId: distinctId && DISTINCT_RE.test(distinctId) ? distinctId : undefined,
  };
}

/**
 * Who an event belongs to. Signed in: the user id. Telegram (unlinked): `tg:<hash>`. Signed-out
 * web: the browser's PostHog id when it sent one, else `anon:<deviceId>`. Never an email or name.
 */
export function distinctIdFor(
  who: { userId?: string | null; deviceId?: string | null },
  ctx: AnalyticsContext = WEB,
): string {
  if (who.userId) return who.userId;
  if (ctx.surface === 'telegram' && who.deviceId) return `tg:${who.deviceId}`;
  if (ctx.distinctId) return ctx.distinctId;
  return who.deviceId ? `anon:${who.deviceId}` : 'anon:unknown';
}

/** Common properties every server event carries. */
export function baseProps(
  who: { userId?: string | null },
  ctx: AnalyticsContext = WEB,
): Record<string, string | number | boolean> {
  return { ...ctx.extra, surface: ctx.surface, anonymous: !who.userId, ...(ctx.source ? { source: ctx.source } : {}) };
}

/**
 * Pseudonymous device id for a Telegram chat: HMAC-SHA256 of `tg:<chatId>` keyed on AUTH_SECRET,
 * hex, first 32 chars. Used as the CheckIn / StatusReport deviceId, so it carries no prefix.
 */
export function hashTelegramId(chatId: number | string, secret: string): string {
  return createHmac('sha256', secret).update(`tg:${chatId}`).digest('hex').slice(0, 32);
}

/** Rounded so a distance can never pin down where someone stood. */
export const roundDistance = (m: number) => Math.round(m / 10) * 10;
