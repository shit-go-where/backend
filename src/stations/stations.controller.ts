import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { StationsService } from './stations.service.js';
import { LineBoardDto, StationDetailDto, StationListDto } from './stations.dto.js';

@ApiTags('stations')
@Controller()
export class StationsController {
  constructor(private readonly stations: StationsService) {}

  @Get('stations')
  @ZodResponse({ status: 200, type: StationListDto })
  async list() {
    return { items: await this.stations.list() };
  }

  @Get('stations/:slug')
  @ZodResponse({ status: 200, type: StationDetailDto })
  detail(@Param('slug') slug: string) {
    return this.stations.detail(slug);
  }

  /** MRT and LRT lines ranked by their stations' toilets (GROWTH.md 2.3). */
  @ApiTags('leaderboard')
  @Get('leaderboard/lines')
  @ZodResponse({ status: 200, type: LineBoardDto })
  async lines() {
    return { items: await this.stations.lineBoard() };
  }
}
