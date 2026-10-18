import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '../common/throttle.js';
import { ZodResponse } from 'nestjs-zod';
import type { User } from '../generated/prisma/client.js';
import { AuthGuard, CurrentUser, OptionalAuthGuard } from '../common/auth/auth.guard.js';
import { StatusService } from './status.service.js';
import { CreateStatusDto, StatusReportDto, StatusReportListDto } from './status.dto.js';

@ApiTags('status')
@Controller()
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @Get('toilets/:id/status')
  @UseGuards(OptionalAuthGuard)
  @ZodResponse({ status: 200, type: StatusReportListDto })
  list(@Param('id') id: string, @CurrentUser({ optional: true }) user: User | null) {
    return this.status.active(id, user?.id ?? null);
  }

  @Post('toilets/:id/status')
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiCookieAuth('sgw_session')
  @ZodResponse({ status: 201, type: StatusReportDto })
  report(@Param('id') id: string, @Body() body: CreateStatusDto, @CurrentUser() user: User) {
    return this.status.report(id, user.id, body.kind);
  }

  @Post('status/:id/confirm')
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiCookieAuth('sgw_session')
  @ZodResponse({ status: 200, type: StatusReportDto })
  confirm(@Param('id') id: string, @CurrentUser() user: User) {
    return this.status.confirm(id, user.id);
  }
}
