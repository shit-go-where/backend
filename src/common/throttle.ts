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
import type { Request, Response } from 'express';
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

/** Client identity: signed-in user id, else the client IP as seen through Vercel's proxy. */
export function trackerFor(req: Request): string {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  const session = verifySessionToken(token);
  if (session) return `u:${session.uid}`;
  const realIp = req.headers['x-real-ip'];
  const fwd = req.headers['x-forwarded-for'];
  const ip =
    (typeof realIp === 'string' && realIp) ||
    (typeof fwd === 'string' && fwd.split(',')[0]?.trim()) ||
    req.ip ||
    'unknown';
  return `ip:${ip}`;
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
    const route = `${ctx.getClass().name}.${ctx.getHandler().name}`;
    const key = `${trackerFor(req)}|${route}`;
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
