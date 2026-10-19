import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { DailyLimiter, Throttle, clientIp } from '../common/throttle.js';
import { ZodResponse } from 'nestjs-zod';
import type { User } from '../generated/prisma/client.js';
import { AuthGuard, CurrentUser, OptionalAuthGuard } from '../common/auth/auth.guard.js';
import { ensureDeviceId } from '../common/auth/anon.js';
import { sgtDayNumber } from '../gamification/sgt.js';
import { StatusService } from './status.service.js';
import { CreateStatusDto, StatusReportDto, StatusReportListDto } from './status.dto.js';

@ApiTags('status')
@Controller()
export class StatusController {
  /** Signed-out reports per IP per Singapore day. */
  private readonly anonPerIp = new DailyLimiter(30);

  constructor(private readonly status: StatusService) {}

  @Get('toilets/:id/status')
  @UseGuards(OptionalAuthGuard)
  @ZodResponse({ status: 200, type: StatusReportListDto })
  list(@Param('id') id: string, @CurrentUser({ optional: true }) user: User | null) {
    return this.status.active(id, user?.id ?? null);
  }

  /** Signed out works too: the device gets an sgw_anon cookie (PLAN.md §12 E4). */
  @Post('toilets/:id/status')
  @UseGuards(OptionalAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiCookieAuth('sgw_session')
  @ZodResponse({ status: 201, type: StatusReportDto })
  report(
    @Param('id') id: string,
    @Body() body: CreateStatusDto,
    @CurrentUser({ optional: true }) user: User | null,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (user) return this.status.report(id, { userId: user.id }, body.kind);
    if (!this.anonPerIp.take(clientIp(req), sgtDayNumber(new Date()))) {
      throw new HttpException('Too many reports from this network today. Sign in to keep reporting.', HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.status.report(id, { deviceId: ensureDeviceId(req, res) }, body.kind);
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
