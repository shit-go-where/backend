import { Body, Controller, Delete, Get, HttpCode, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '../common/throttle.js';
import { ZodResponse } from 'nestjs-zod';
import type { Response } from 'express';
import { AuthGuard, CurrentUser } from '../common/auth/auth.guard.js';
import { SESSION_COOKIE, sessionCookieOptions } from '../common/auth/session.js';
import type { User } from '../generated/prisma/client.js';
import {
  ActivityPageDto,
  ActivityQueryDto,
  ActivitySeenDto,
  MeDto,
  TelegramLinkTokenDto,
  UpdateMeDto,
} from './users.dto.js';
import { UsersService } from './users.service.js';

// Only fixed sub-paths here: GET /me/passport lives in the gamification module.
@ApiTags('me')
@ApiCookieAuth()
@UseGuards(AuthGuard)
@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ZodResponse({ type: MeDto })
  me(@CurrentUser() user: User) {
    return this.users.getMe(user.id);
  }

  @Patch()
  @ZodResponse({ type: MeDto })
  update(@CurrentUser() user: User, @Body() body: UpdateMeDto) {
    return this.users.updateMe(user.id, body);
  }

  @Delete()
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Account deleted and contributions anonymised' })
  async remove(@CurrentUser() user: User, @Res({ passthrough: true }) res: Response) {
    await this.users.deleteMe(user.id);
    const { maxAge: _maxAge, ...opts } = sessionCookieOptions();
    res.clearCookie(SESSION_COOKIE, opts);
  }

  @Get('activity')
  @ZodResponse({ type: ActivityPageDto })
  activity(@CurrentUser() user: User, @Query() query: ActivityQueryDto) {
    return this.users.activity(user.id, query);
  }

  /** Marks everything in GET /me's `unseen` as seen (the Me page was opened). */
  @Post('activity/seen')
  @HttpCode(200)
  @ZodResponse({ type: ActivitySeenDto })
  activitySeen(@CurrentUser() user: User) {
    return this.users.markActivitySeen(user.id);
  }

  /** One-time t.me link that connects a Telegram chat to this account (BOT.md T15). 503 without a bot. */
  @Post('telegram/link-token')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ZodResponse({ status: 200, type: TelegramLinkTokenDto })
  telegramLinkToken(@CurrentUser() user: User) {
    return this.users.createTelegramLinkToken(user.id);
  }

  @Delete('telegram')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Telegram chat unlinked' })
  async telegramUnlink(@CurrentUser() user: User) {
    await this.users.unlinkTelegram(user.id);
  }
}
