import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Role } from '../generated/prisma/enums.js';
import type { User } from '../generated/prisma/client.js';

export const OAUTH_STATE_COOKIE = 'sgw_oauth';
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

/**
 * Post-login redirect must be a same-origin relative path. Rejects protocol-relative ("//x"),
 * backslash tricks ("/\\x"), absolute URLs and control characters.
 */
export function safeRedirect(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return '/';
  if (typeof input !== 'string' || input.length > 512) return null;
  if (!input.startsWith('/')) return null;
  if (input.startsWith('//') || input.startsWith('/\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(input)) return null;
  try {
    // Must stay on the same origin once resolved.
    const base = new URL('http://sgw.invalid');
    const url = new URL(input, base);
    if (url.origin !== base.origin) return null;
  } catch {
    return null;
  }
  return input;
}

function hmac(data: string): string {
  return createHmac('sha256', env.AUTH_SECRET).update(`oauth:${data}`).digest('base64url');
}

/** Cookie value: base64url(json{state,redirect,exp}).sig */
export function encodeStateCookie(state: string, redirect: string, now = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ s: state, r: redirect, e: now + OAUTH_STATE_TTL_MS }),
  ).toString('base64url');
  return `${body}.${hmac(body)}`;
}

export function decodeStateCookie(
  value: string | undefined,
  now = Date.now(),
): { state: string; redirect: string } | null {
  if (!value) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(hmac(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      s: unknown;
      r: unknown;
      e: unknown;
    };
    if (typeof p.s !== 'string' || typeof p.e !== 'number' || p.e < now) return null;
    const redirect = safeRedirect(p.r);
    if (!redirect) return null;
    return { state: p.s, redirect };
  } catch {
    return null;
  }
}

export function isAdminEmail(email: string): boolean {
  return env.ADMIN_EMAILS.includes(email.toLowerCase());
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  get googleConfigured(): boolean {
    return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  }

  get redirectUri(): string {
    return `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/api/auth/callback`;
  }

  assertGoogleConfigured(): void {
    if (!this.googleConfigured) {
      throw new ServiceUnavailableException(
        'Google sign-in is not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)',
      );
    }
  }

  /** Starts the flow: returns the Google URL and the cookie value carrying state + redirect. */
  beginGoogle(redirect: string): { url: string; cookie: string } {
    this.assertGoogleConfigured();
    const state = randomBytes(24).toString('base64url');
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
      access_type: 'online',
    }).toString();
    return { url: url.toString(), cookie: encodeStateCookie(state, redirect) };
  }

  /** Exchanges the code and returns the verified Google profile. */
  async exchangeCode(code: string): Promise<GoogleProfile> {
    this.assertGoogleConfigured();
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenRes.ok) throw new UnauthorizedException('Google sign-in failed (token exchange)');
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) throw new UnauthorizedException('Google sign-in failed (no token)');

    const infoRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!infoRes.ok) throw new UnauthorizedException('Google sign-in failed (profile)');
    const p = (await infoRes.json()) as Partial<GoogleProfile> & { email_verified?: unknown };
    if (typeof p.sub !== 'string' || typeof p.email !== 'string') {
      throw new UnauthorizedException('Google sign-in failed (incomplete profile)');
    }
    // Google returns a boolean; tolerate the legacy string form.
    const ev: unknown = p.email_verified;
    const verified = ev === true || ev === 'true';
    if (!verified) throw new UnauthorizedException('Google account email is not verified');
    return {
      sub: p.sub,
      email: p.email.toLowerCase(),
      email_verified: true,
      name: typeof p.name === 'string' ? p.name : undefined,
      picture: typeof p.picture === 'string' ? p.picture : undefined,
    };
  }

  /** Find by googleSub, then by email (links the account), else create. */
  async upsertGoogleUser(p: GoogleProfile): Promise<User> {
    const admin = isAdminEmail(p.email);
    const bySub = await this.prisma.user.findUnique({ where: { googleSub: p.sub } });
    const existing = bySub ?? (await this.prisma.user.findUnique({ where: { email: p.email } }));
    if (existing) {
      return this.prisma.user.update({
        where: { id: existing.id },
        data: {
          googleSub: p.sub,
          email: p.email,
          avatarUrl: p.picture ?? existing.avatarUrl,
          ...(admin && existing.role !== Role.ADMIN ? { role: Role.ADMIN } : {}),
        },
      });
    }
    return this.prisma.user.create({
      data: {
        email: p.email,
        googleSub: p.sub,
        displayName: displayNameFrom(p.name, p.email),
        avatarUrl: p.picture ?? null,
        role: admin ? Role.ADMIN : Role.USER,
      },
    });
  }

  async upsertDevUser(email: string, displayName?: string): Promise<User> {
    const e = email.toLowerCase();
    const admin = isAdminEmail(e);
    return this.prisma.user.upsert({
      where: { email: e },
      create: {
        email: e,
        displayName: displayNameFrom(displayName, e),
        role: admin ? Role.ADMIN : Role.USER,
      },
      update: {
        ...(displayName ? { displayName } : {}),
        ...(admin ? { role: Role.ADMIN } : {}),
      },
    });
  }
}

function displayNameFrom(name: string | undefined, email: string): string {
  const n = name?.trim();
  if (n) return n.slice(0, 50);
  return email.split('@')[0].slice(0, 50) || 'User';
}
