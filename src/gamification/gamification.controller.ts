import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import type { Request, Response } from 'express';
import { AuthGuard, CurrentUser, OptionalAuthGuard } from '../common/auth/auth.guard.js';
import { ensureDeviceId } from '../common/auth/anon.js';
import { DailyLimiter, Throttle, clientIp } from '../common/throttle.js';
import { sgtDayNumber } from './sgt.js';
import { analyticsFromRequest } from '../analytics/analytics.js';
import type { User } from '../generated/prisma/client.js';
import { GamificationService } from './gamification.service.js';
import {
  BadgeListDto,
  CheckInDto,
  CheckInResultDto,
  LeaderboardDto,
  LeaderboardQueryDto,
  OkDto,
  PassportDto,
  VerifyDto,
} from './gamification.schemas.js';

@ApiTags('gamification')
@Controller()
export class GamificationController {
  /** Signed-out check-ins per IP per Singapore day, on top of 5 per device. */
  private readonly anonPerIp = new DailyLimiter(30);

  constructor(@Inject(GamificationService) private readonly gamification: GamificationService) {}

  /** Signed out works too: the device gets an sgw_anon cookie and its points are banked (PLAN.md §12 E4). */
  @Post('toilets/:id/check-ins')
  @UseGuards(OptionalAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiCookieAuth()
  @ZodResponse({ status: 201, type: CheckInResultDto })
  checkIn(
    @CurrentUser({ optional: true }) user: User | null,
    @Param('id') id: string,
    @Body() body: CheckInDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const analytics = analyticsFromRequest(req);
    if (user) return this.gamification.checkIn(user, id, body.lat, body.lng, analytics);
    if (!this.anonPerIp.take(clientIp(req), sgtDayNumber(new Date()))) {
      throw new HttpException(
        'Too many check-ins from this network today. Sign in to keep going.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.gamification.anonymousCheckIn(ensureDeviceId(req, res), id, body.lat, body.lng, analytics);
  }

  /** `accurate: false` creates a Flag, so this shares the flag endpoint's tight limit. */
  @Post('toilets/:id/verify')
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiCookieAuth()
  @ZodResponse({ status: 200, type: OkDto })
  verify(@CurrentUser() user: User, @Param('id') id: string, @Body() body: VerifyDto) {
    return this.gamification.verify(user, id, body);
  }

  @Get('me/passport')
  @UseGuards(AuthGuard)
  @ApiCookieAuth()
  @ZodResponse({ status: 200, type: PassportDto })
  passport(@CurrentUser() user: User) {
    return this.gamification.passport(user);
  }

  @Get('leaderboard/users')
  @UseGuards(OptionalAuthGuard)
  @ZodResponse({ status: 200, type: LeaderboardDto })
  leaderboard(@CurrentUser({ optional: true }) user: User | null, @Query() query: LeaderboardQueryDto) {
    return this.gamification.leaderboard(query.scope, user);
  }

  @Get('badges')
  @UseGuards(OptionalAuthGuard)
  @ZodResponse({ status: 200, type: BadgeListDto })
  badges(@CurrentUser({ optional: true }) user: User | null) {
    return this.gamification.listBadges(user);
  }
}
