import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * Stateless signed session token stored in an httpOnly cookie.
 * Format: base64url(json payload).base64url(hmac-sha256).
 * The role is NOT trusted from the token; guards reload the user from the DB.
 */
export const SESSION_COOKIE = 'sgw_session';
export const SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 days

export interface SessionPayload {
  uid: string;
  exp: number; // unix seconds
}

function sign(data: string): string {
  return createHmac('sha256', env.AUTH_SECRET).update(data).digest('base64url');
}

export function createSessionToken(uid: string, ttlS = SESSION_TTL_S): string {
  const payload: SessionPayload = { uid, exp: Math.floor(Date.now() / 1000) + ttlS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifySessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionPayload;
    if (typeof payload.uid !== 'string' || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_S * 1000,
  };
}
