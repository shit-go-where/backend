import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { VenuesService } from './venues.service.js';
import {
  VenueDetailDto,
  VenueLiteListDto,
  VenueNearbyListDto,
  VenueNearbyQueryDto,
  VenueSearchQueryDto,
} from './venues.dto.js';

@ApiTags('venues')
@Controller('venues')
export class VenuesController {
  constructor(private readonly venues: VenuesService) {}

  @Get('nearby')
  @ZodResponse({ status: 200, type: VenueNearbyListDto })
  async nearby(@Query() q: VenueNearbyQueryDto) {
    return { items: await this.venues.nearby({ lat: q.lat, lng: q.lng }, q.radius) };
  }

  @Get('search')
  @ZodResponse({ status: 200, type: VenueLiteListDto })
  async search(@Query() q: VenueSearchQueryDto) {
    const origin = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : undefined;
    return { items: await this.venues.search(q.q, origin) };
  }

  @Get(':id')
  @ZodResponse({ status: 200, type: VenueDetailDto })
  detail(@Param('id') id: string) {
    return this.venues.detail(id);
  }
}
