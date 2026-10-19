import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiFoundResponse, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '../common/throttle.js';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import {
  SESSION_COOKIE,
  createSessionToken,
  sessionCookieOptions,
} from '../common/auth/session.js';
import { MeDto } from '../users/users.dto.js';
import { UsersService } from '../users/users.service.js';
import { clearAnonCookie, readDeviceId } from '../common/auth/anon.js';
import { GamificationService } from '../gamification/gamification.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import {
  AuthService,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  decodeStateCookie,
  safeRedirect,
} from './auth.service.js';

class GoogleStartQuery extends createZodDto(
  z.object({ redirect: z.string().max(512).optional() }),
) {}

class CallbackQuery extends createZodDto(
  z.object({
    code: z.string().max(2048).optional(),
    state: z.string().max(512).optional(),
    error: z.string().max(200).optional(),
  }),
) {}

class DevLoginBody extends createZodDto(
  z.object({
    email: z.email().max(254),
    displayName: z.string().trim().min(1).max(50).optional(),
  }),
) {}

function stateCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

/** Read by the frontend's /login page to explain what went wrong. */
export type AuthErrorCode = 'access_denied' | 'no_code' | 'email_unverified' | 'google_failed' | 'expired';

function appUrl(path: string, params?: Record<string, string>): string {
  const base = env.PUBLIC_APP_URL.replace(/\/$/, '');
  if (!params) return base + path;
  const sep = path.includes('?') ? '&' : '?';
  return `${base}${path}${sep}${new URLSearchParams(params).toString()}`;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly log = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly gamification: GamificationService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** `signin` event (GROWTH.md 0.1). New = account created in the last minute. */
  private trackSignin(user: { id: string; createdAt: Date }, method: 'google' | 'dev') {
    this.analytics.track('signin', user.id, {
      surface: 'web',
      anonymous: false,
      method,
      new_user: Date.now() - user.createdAt.getTime() < 60_000,
    });
  }

  /**
   * After any sign-in: move this browser's anonymous check-ins and status reports (sgw_anon) to the
   * account, pay their banked points, and drop the cookie. Never blocks the sign-in itself.
   */
  private async mergeAnonymous(userId: string, req: Request, res: Response) {
    const deviceId = readDeviceId(req);
    if (!deviceId) return;
    try {
      await this.gamification.mergeDevice(userId, deviceId);
      clearAnonCookie(res);
    } catch (e) {
      this.log.warn(`anonymous merge failed for ${userId}: ${String(e)}`);
    }
  }

  @Get('google')
  @ApiFoundResponse({ description: 'Redirects to Google' })
  google(@Query() query: GoogleStartQuery, @Res() res: Response) {
    const redirect = safeRedirect(query.redirect);
    if (!redirect) throw new BadRequestException('redirect must be a relative path starting with /');
    const { url, cookie } = this.auth.beginGoogle(redirect);
    res.cookie(OAUTH_STATE_COOKIE, cookie, { ...stateCookieOptions(), maxAge: OAUTH_STATE_TTL_MS });
    res.redirect(302, url);
  }

  @Get('callback')
  @ApiFoundResponse({
    description:
      'Sets the session cookie and redirects to the app; on any failure redirects to /login?redirect=&error=<code>',
  })
  async callback(@Query() query: CallbackQuery, @Req() req: Request, @Res() res: Response) {
    this.auth.assertGoogleConfigured();
    const cookies = req.cookies as Record<string, string> | undefined;
    const saved = decodeStateCookie(cookies?.[OAUTH_STATE_COOKIE]);
    res.clearCookie(OAUTH_STATE_COOKIE, stateCookieOptions());
    // Every failure lands on the login page, which explains it and offers to try again.
    const fail = (error: AuthErrorCode) =>
      res.redirect(302, appUrl('/login', { redirect: saved?.redirect ?? '/', error }));
    if (!saved || !query.state || saved.state !== query.state) return fail('expired');
    // User cancelled at Google (error=access_denied) or Google sent no code.
    if (query.error) return fail('access_denied');
    if (!query.code) return fail('no_code');
    let profile;
    try {
      profile = await this.auth.exchangeCode(query.code);
    } catch (e) {
      return fail(e instanceof Error && /not verified/.test(e.message) ? 'email_unverified' : 'google_failed');
    }
    const user = await this.auth.upsertGoogleUser(profile);
    await this.mergeAnonymous(user.id, req, res);
    this.trackSignin(user, 'google');
    res.cookie(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions());
    res.redirect(302, appUrl(saved.redirect));
  }

  @Post('logout')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Session cookie cleared' })
  logout(@Res({ passthrough: true }) res: Response) {
    const { maxAge: _maxAge, ...opts } = sessionCookieOptions();
    res.clearCookie(SESSION_COOKIE, opts);
  }

  @Post('dev-login')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ZodResponse({ type: MeDto })
  async devLogin(@Body() body: DevLoginBody, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!env.DEV_LOGIN_ENABLED) throw new NotFoundException();
    const user = await this.auth.upsertDevUser(body.email, body.displayName);
    await this.mergeAnonymous(user.id, req, res);
    this.trackSignin(user, 'dev');
    res.cookie(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions());
    return this.users.getMe(user.id);
  }
}
