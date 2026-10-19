import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { DailyLimiter, Throttle, clientIp } from '../common/throttle.js';
import { sgtDayNumber } from '../gamification/sgt.js';
import { RouteCountService } from './route-count.service.js';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { estimateWalkSeconds, haversineM } from '../common/geo.js';
import { OneMapService } from './onemap.service.js';
import { RecommendService } from './recommend.service.js';
import { walkingMetres } from './ranking.js';
import {
  GeoSearchQueryDto,
  GeoSearchResponseDto,
  RecommendBodyDto,
  RecommendResponseDto,
  RouteStartedBodyDto,
  RouteStartedResponseDto,
  WalkQueryDto,
  WalkResponseDto,
} from './routing.dto.js';

@ApiTags('routing')
@Controller('routing')
export class RoutingController {
  /** Route starts per IP per Singapore day, so one script cannot inflate the counts. */
  private readonly startsPerIp = new DailyLimiter(100);

  constructor(
    private readonly recommender: RecommendService,
    private readonly onemap: OneMapService,
    private readonly routeCounts: RouteCountService,
  ) {}

  /** Someone started walking to this toilet. Anonymous; only a per-day count is kept (GROWTH.md 1.3). */
  @Post('started')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ZodResponse({ status: 200, type: RouteStartedResponseDto })
  async started(@Body() body: RouteStartedBodyDto, @Req() req: Request) {
    if (!this.startsPerIp.take(clientIp(req), sgtDayNumber(new Date()))) {
      throw new HttpException('Too many routes from this network today', HttpStatus.TOO_MANY_REQUESTS);
    }
    await this.routeCounts.record(body.toiletId);
    return { ok: true as const };
  }

  @Post('recommend')
  @ZodResponse({ status: 200, type: RecommendResponseDto })
  recommend(@Body() body: RecommendBodyDto) {
    return this.recommender.recommend(body);
  }

  /** OneMap walking route (token stays server-side). Falls back to a straight-line estimate. */
  @Get('walk')
  @ZodResponse({ status: 200, type: WalkResponseDto })
  async walk(@Query() q: WalkQueryDto) {
    const from = { lat: q.fromLat, lng: q.fromLng };
    const to = { lat: q.toLat, lng: q.toLng };
    const route = await this.onemap.walk(from, to);
    if (route) return route;
    const d = haversineM(from, to);
    return {
      distanceM: walkingMetres(d),
      durationS: estimateWalkSeconds(d),
      polyline: [
        [from.lat, from.lng],
        [to.lat, to.lng],
      ] as [number, number][],
      source: 'estimate' as const,
    };
  }
}

@ApiTags('routing')
@Controller('geo')
export class GeoController {
  constructor(private readonly onemap: OneMapService) {}

  @Get('search')
  @ZodResponse({ status: 200, type: GeoSearchResponseDto })
  async search(@Query() q: GeoSearchQueryDto) {
    return { items: (await this.onemap.search(q.q)).slice(0, 10) };
  }
}
