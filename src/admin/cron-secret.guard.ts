import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { env } from '../config/env.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time comparison (hashing first makes lengths equal). */
export function secretMatches(given: string | undefined, expected: string): boolean {
  if (typeof given !== 'string' || given.length === 0) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** Guards maintenance jobs: header `x-cron-secret` must equal CRON_SECRET. No session needed. */
@Injectable()
export class CronSecretGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const secret = env.CRON_SECRET;
    if (!secret) throw new ServiceUnavailableException('CRON_SECRET is not configured');
    const header = ctx.switchToHttp().getRequest<Request>().headers['x-cron-secret'];
    if (!secretMatches(Array.isArray(header) ? header[0] : header, secret)) {
      throw new UnauthorizedException('Invalid cron secret');
    }
    return true;
  }
}
