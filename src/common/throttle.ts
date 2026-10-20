/**
 * Minimal fixed-window rate limiter (replaces @nestjs/throttler).
 *
 * Why not @nestjs/throttler: its latest release (6.x) is CommonJS and `require()`s the ESM-only
 * @nestjs/common 12. Node 24 tolerates that locally, but Vercel's function loader does not
 * (ERR_REQUIRE_ESM at cold start), which took the whole API down.
 *
 * Same decorator API as before: `@Throttle({ default: { limit, ttl } })` and `@SkipThrottle()`.
 * Limits key on the signed-in user (from the session cookie) and fall back to the client IP.
 * Counters are in memory per instance, which is what the previous in-memory storage did too.
 */
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { SESSION_COOKIE, verifySessionToken } from './auth/session.js';

export interface ThrottleLimit {
  limit: number;
  /** Window length in milliseconds. */
  ttl: number;
}

export const DEFAULT_LIMIT: ThrottleLimit = { limit: 120, ttl: 60_000 };

const THROTTLE_KEY = 'sgw:throttle';
const SKIP_KEY = 'sgw:skipThrottle';
const MAX_KEYS = 50_000;

/** Override the limit for a route or controller. Shape kept from @nestjs/throttler. */
export const Throttle = (opts: { default: ThrottleLimit }) => SetMetadata(THROTTLE_KEY, opts.default);
/** Exempt a route or controller (e.g. cron endpoints). */
export const SkipThrottle = () => SetMetadata(SKIP_KEY, true);

interface Window {
  count: number;
  resetAt: number;
}

export const PROXY_SECRET_HEADER = 'x-sgw-proxy-secret';
export const PROXY_CLIENT_IP_HEADER = 'x-sgw-client-ip';

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * True when the request carries the frontend's proxy secret (API_PROXY_SECRET). Only then are the
 * forwarded client-IP headers trusted: anyone can call the API origin directly and set headers.
 */
export function fromTrustedProxy(req: Request): boolean {
  const secret = env.API_PROXY_SECRET;
  const given = header(req, PROXY_SECRET_HEADER);
  if (!secret || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The client IP. Through the Next rewrite on Vercel, X-Forwarded-For is the frontend proxy's own
 * address (Vercel overwrites it), so the frontend forwards the phone's IP in `x-sgw-client-ip`,
 * trusted only with the proxy secret. Direct callers fall back to the proxy headers Vercel sets.
 */
export function clientIp(req: Request): string {
  if (fromTrustedProxy(req)) {
    const forwarded = header(req, PROXY_CLIENT_IP_HEADER)?.trim();
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  const realIp = req.headers['x-real-ip'];
  const fwd = req.headers['x-forwarded-for'];
  return (
    (typeof realIp === 'string' && realIp) ||
    (typeof fwd === 'string' && fwd.split(',')[0]?.trim()) ||
    req.ip ||
    'unknown'
  );
}

/**
 * Client identity: signed-in user id, else the client IP. Null for a verified request from the
 * frontend's own server (proxy secret, no client IP: a server-side render on behalf of nobody in
 * particular), which the guard lets through: those share one egress IP and would otherwise exhaust
 * every anonymous limit on their own.
 */
export function trackerFor(req: Request): string | null {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  const session = verifySessionToken(token);
  if (session) return `u:${session.uid}`;
  if (fromTrustedProxy(req) && !header(req, PROXY_CLIENT_IP_HEADER)) return null;
  return `ip:${clientIp(req)}`;
}

/**
 * Per-key daily counter (e.g. anonymous check-ins per IP per Singapore day). In memory per instance,
 * like the throttle windows: a soft cap that stops casual abuse, not a guarantee.
 */
export class DailyLimiter {
  private readonly counts = new Map<string, number>();
  private day = -1;

  constructor(private readonly limit: number) {}

  /** Counts one use; false when the key is already at the limit today (and nothing is counted). */
  take(key: string, dayNumber: number): boolean {
    if (dayNumber !== this.day) {
      this.counts.clear();
      this.day = dayNumber;
    }
    const n = this.counts.get(key) ?? 0;
    if (n >= this.limit) return false;
    if (this.counts.size >= MAX_KEYS) this.counts.clear();
    this.counts.set(key, n + 1);
    return true;
  }
}

@Injectable()
export class ThrottleGuard implements CanActivate {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_KEY, targets)) return true;
    const { limit, ttl } =
      this.reflector.getAllAndOverride<ThrottleLimit | undefined>(THROTTLE_KEY, targets) ?? DEFAULT_LIMIT;

    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const tracker = trackerFor(req);
    if (tracker === null) return true;
    const route = `${ctx.getClass().name}.${ctx.getHandler().name}`;
    const key = `${tracker}|${route}`;
    const now = Date.now();

    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      if (this.windows.size >= MAX_KEYS) this.sweep(now);
      w = { count: 0, resetAt: now + ttl };
      this.windows.set(key, w);
    }
    w.count++;

    const remaining = Math.max(0, limit - w.count);
    const resetS = Math.ceil((w.resetAt - now) / 1000);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetS));
    if (w.count > limit) {
      res.setHeader('Retry-After', String(resetS));
      throw new HttpException('Too many requests, slow down a bit.', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  /** Drop expired windows; if still full, drop the oldest half. */
  private sweep(now: number) {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    if (this.windows.size < MAX_KEYS) return;
    let n = Math.floor(this.windows.size / 2);
    for (const k of this.windows.keys()) {
      if (n-- <= 0) break;
      this.windows.delete(k);
    }
  }
}
