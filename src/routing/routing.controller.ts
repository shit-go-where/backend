import { Body, Controller, Get, Post, Query } from '@nestjs/common';
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
  WalkQueryDto,
  WalkResponseDto,
} from './routing.dto.js';

@ApiTags('routing')
@Controller('routing')
export class RoutingController {
  constructor(
    private readonly recommender: RecommendService,
    private readonly onemap: OneMapService,
  ) {}

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
