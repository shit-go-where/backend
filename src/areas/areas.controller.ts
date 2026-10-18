import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { AreasService } from './areas.service.js';
import { AreaDetailDto, AreaListDto } from './areas.dto.js';

@ApiTags('areas')
@Controller('areas')
export class AreasController {
  constructor(private readonly areas: AreasService) {}

  @Get()
  @ZodResponse({ status: 200, type: AreaListDto })
  async list() {
    return { items: await this.areas.list() };
  }

  @Get(':slug')
  @ZodResponse({ status: 200, type: AreaDetailDto })
  detail(@Param('slug') slug: string) {
    return this.areas.detail(slug);
  }
}
