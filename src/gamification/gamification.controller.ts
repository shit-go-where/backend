import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { AuthGuard, CurrentUser, OptionalAuthGuard } from '../common/auth/auth.guard.js';
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
  constructor(@Inject(GamificationService) private readonly gamification: GamificationService) {}

  @Post('toilets/:id/check-ins')
  @UseGuards(AuthGuard)
  @ApiCookieAuth()
  @ZodResponse({ status: 201, type: CheckInResultDto })
  checkIn(@CurrentUser() user: User, @Param('id') id: string, @Body() body: CheckInDto) {
    return this.gamification.checkIn(user, id, body.lat, body.lng);
  }

  @Post('toilets/:id/verify')
  @UseGuards(AuthGuard)
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
