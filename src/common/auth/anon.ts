import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../../config/env.js';

/**
 * Anonymous device identity for signed-out check-ins and status reports (PLAN.md §12 E4).
 * The cookie holds a random UUID and an HMAC of it (same AUTH_SECRET as sessions, own prefix),
 * nothing else: no PII, no coordinates. It is cleared once its contributions are merged into an
 * account on sign-in.
 */
export const ANON_COOKIE = 'sgw_anon';
export const ANON_TTL_MS = 365 * 86_400_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sign(id: string): string {
  return createHmac('sha256', env.AUTH_SECRET).update(`anon:${id}`).digest('base64url');
}

export function createAnonToken(id: string = randomUUID()): string {
  return `${id}.${sign(id)}`;
}

/** The device id inside a valid cookie value, else null. */
export function verifyAnonToken(token: string | undefined): string | null {
  if (!token) return null;
  const [id, sig] = token.split('.');
  if (!id || !sig || !UUID_RE.test(id)) return null;
  const expected = Buffer.from(sign(id));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return id;
}

export function anonCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: ANON_TTL_MS,
  };
}

export function readDeviceId(req: Request): string | null {
  return verifyAnonToken((req.cookies as Record<string, string> | undefined)?.[ANON_COOKIE]);
}

/** This request's device id, issuing a new cookie on the response when there is none (or it is invalid). */
export function ensureDeviceId(req: Request, res: Response): string {
  const existing = readDeviceId(req);
  if (existing) return existing;
  const id = randomUUID();
  res.cookie(ANON_COOKIE, createAnonToken(id), anonCookieOptions());
  return id;
}

export function clearAnonCookie(res: Response): void {
  const { maxAge: _maxAge, ...opts } = anonCookieOptions();
  res.clearCookie(ANON_COOKIE, opts);
}
