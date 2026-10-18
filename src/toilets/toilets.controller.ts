import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import type { User } from '../generated/prisma/client.js';
import { CurrentUser, OptionalAuthGuard } from '../common/auth/auth.guard.js';
import { ToiletsService } from './toilets.service.js';
import {
  InBoundsQueryDto,
  LeaderboardQueryDto,
  NearbyQueryDto,
  ToiletDetailDto,
  ToiletLeaderboardDto,
  ToiletPinListDto,
  ToiletSitemapDto,
  ToiletSummaryListDto,
} from './toilets.dto.js';

@ApiTags('toilets')
@Controller('toilets')
export class ToiletsController {
  constructor(private readonly toilets: ToiletsService) {}

  @Get('nearby')
  @ZodResponse({ status: 200, type: ToiletSummaryListDto })
  async nearby(@Query() q: NearbyQueryDto) {
    const items = await this.toilets.nearby({ lat: q.lat, lng: q.lng }, q);
    return { items };
  }

  @Get('in-bounds')
  @ZodResponse({ status: 200, type: ToiletPinListDto })
  async inBounds(@Query() q: InBoundsQueryDto) {
    const items = await this.toilets.inBounds(q, q);
    return { items };
  }

  /** Every toilet with a public page, for the frontend's sitemap.xml. */
  @Get('sitemap')
  @ZodResponse({ status: 200, type: ToiletSitemapDto })
  async sitemap() {
    return { items: await this.toilets.sitemap() };
  }

  @Get(':id')
  @UseGuards(OptionalAuthGuard)
  @ZodResponse({ status: 200, type: ToiletDetailDto })
  detail(@Param('id') id: string, @CurrentUser({ optional: true }) user: User | null) {
    return this.toilets.detail(id, user?.id ?? null);
  }
}

@ApiTags('leaderboard')
@Controller('leaderboard')
export class ToiletLeaderboardController {
  constructor(private readonly toilets: ToiletsService) {}

  @Get('toilets')
  @ZodResponse({ status: 200, type: ToiletLeaderboardDto })
  leaderboard(@Query() q: LeaderboardQueryDto) {
    return this.toilets.leaderboard(q.area);
  }
}
