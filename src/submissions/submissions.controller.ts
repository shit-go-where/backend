import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
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
  QueueQueryDto,
  ResolveDto,
  SubmissionListDto,
  SubmissionViewDto,
  VoteDto,
} from './submissions.schemas.js';

@ApiTags('submissions')
@ApiCookieAuth()
@Controller('submissions')
export class SubmissionsController {
  constructor(@Inject(SubmissionsService) private readonly submissions: SubmissionsService) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiBody({ type: CreateSubmissionDto })
  @ZodResponse({ status: 201, type: SubmissionViewDto })
  create(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(CreateSubmissionSchema)) body: CreateSubmissionBody,
  ) {
    return this.submissions.create(user, body);
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

  @Post(':id/votes')
  @UseGuards(AuthGuard)
  @ZodResponse({ status: 201, type: SubmissionViewDto })
  vote(@CurrentUser() user: User, @Param('id') id: string, @Body() body: VoteDto) {
    return this.submissions.vote(user, id, body);
  }

  @Post(':id/resolve')
  @UseGuards(RolesGuard)
  @MinRole(Role.MODERATOR)
  @ZodResponse({ status: 200, type: SubmissionViewDto })
  resolve(@CurrentUser() user: User, @Param('id') id: string, @Body() body: ResolveDto) {
    return this.submissions.resolve(user, id, body);
  }
}
