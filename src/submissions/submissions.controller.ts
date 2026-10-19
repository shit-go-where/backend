import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { analyticsFromRequest, baseProps } from '../analytics/analytics.js';
import type { Request } from 'express';
import { ApiBody, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse, ZodValidationPipe } from 'nestjs-zod';
import { AuthGuard, CurrentUser, MinRole, RolesGuard } from '../common/auth/auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { Role } from '../generated/prisma/enums.js';
import { SubmissionsService } from './submissions.service.js';
import {
  CreateSubmissionDto,
  CreateSubmissionSchema,
  type CreateSubmissionBody,
  ModeratorQueueQueryDto,
  ModeratorSubmissionListDto,
  QueueQueryDto,
  ResolveDto,
  SubmissionListDto,
  SubmissionViewDto,
  UpdateSubmissionDto,
  VoteDto,
} from './submissions.schemas.js';

@ApiTags('submissions')
@ApiCookieAuth()
@Controller('submissions')
export class SubmissionsController {
  constructor(
    @Inject(SubmissionsService) private readonly submissions: SubmissionsService,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
  ) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiBody({ type: CreateSubmissionDto })
  @ZodResponse({ status: 201, type: SubmissionViewDto })
  async create(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(CreateSubmissionSchema)) body: CreateSubmissionBody,
    @Req() req: Request,
  ) {
    const view = await this.submissions.create(user, body);
    this.analytics.track('submission', user.id, {
      ...baseProps({ userId: user.id }, analyticsFromRequest(req)),
      kind: view.kind,
      state: view.state,
      on_site: body.lat !== undefined && body.lng !== undefined,
    });
    return view;
  }

  @Get('queue')
  @UseGuards(AuthGuard)
  @ZodResponse({ status: 200, type: SubmissionListDto })
  queue(@CurrentUser() user: User, @Query() query: QueueQueryDto) {
    return this.submissions.queue(user, query);
  }

  @Get('mine')
  @UseGuards(AuthGuard)
  @ZodResponse({ status: 200, type: SubmissionListDto })
  mine(@CurrentUser() user: User) {
    return this.submissions.mine(user);
  }

  @Get(':id')
  @UseGuards(AuthGuard)
  @ZodResponse({ status: 200, type: SubmissionViewDto })
  get(@CurrentUser() user: User, @Param('id') id: string) {
    return this.submissions.get(id, user);
  }

  /** Answer NEEDS_INFO: owner only, puts it back to PENDING. */
  @Patch(':id')
  @UseGuards(AuthGuard)
  @ZodResponse({ status: 200, type: SubmissionViewDto })
  update(@CurrentUser() user: User, @Param('id') id: string, @Body() body: UpdateSubmissionDto) {
    return this.submissions.update(user, id, body);
  }

  @Post(':id/votes')
  @UseGuards(AuthGuard)
  @ZodResponse({ status: 201, type: SubmissionViewDto })
  async vote(@CurrentUser() user: User, @Param('id') id: string, @Body() body: VoteDto, @Req() req: Request) {
    const view = await this.submissions.vote(user, id, body);
    this.analytics.track('vote', user.id, {
      ...baseProps({ userId: user.id }, analyticsFromRequest(req)),
      value: body.value,
      kind: view.kind,
      on_site: body.lat !== undefined && body.lng !== undefined,
    });
    return view;
  }

  @Post(':id/resolve')
  @UseGuards(RolesGuard)
  @MinRole(Role.MODERATOR)
  @ZodResponse({ status: 200, type: SubmissionViewDto })
  resolve(@CurrentUser() user: User, @Param('id') id: string, @Body() body: ResolveDto) {
    return this.submissions.resolve(user, id, body);
  }
}

/** Island-wide moderator queue (PLAN.md §12 E3). Resolve with POST /submissions/:id/resolve. */
@ApiTags('admin')
@ApiCookieAuth()
@UseGuards(RolesGuard)
@MinRole(Role.MODERATOR)
@Controller('admin/submissions')
export class AdminSubmissionsController {
  constructor(@Inject(SubmissionsService) private readonly submissions: SubmissionsService) {}

  @Get()
  @ZodResponse({ status: 200, type: ModeratorSubmissionListDto })
  list(@CurrentUser() user: User, @Query() query: ModeratorQueueQueryDto) {
    return this.submissions.moderatorQueue(user, query.state);
  }
}
