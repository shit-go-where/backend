import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { analyticsFromRequest, baseProps } from '../analytics/analytics.js';
import type { Request } from 'express';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { Throttle } from '../common/throttle.js';
import type { User } from '../generated/prisma/client.js';
import { AuthGuard, CurrentUser } from '../common/auth/auth.guard.js';
import { ReviewsService } from './reviews.service.js';
import { CreateReviewDto, ReviewDto, ReviewListQueryDto, ReviewPageDto } from './reviews.dto.js';

@ApiTags('reviews')
@Controller('toilets/:id/reviews')
export class ReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly analytics: AnalyticsService,
  ) {}

  @Get()
  @ZodResponse({ status: 200, type: ReviewPageDto })
  list(@Param('id') id: string, @Query() q: ReviewListQueryDto) {
    return this.reviews.list(id, q.cursor, q.limit);
  }

  @Post()
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiCookieAuth('sgw_session')
  @ZodResponse({ status: 201, type: ReviewDto })
  async create(@Param('id') id: string, @Body() body: CreateReviewDto, @CurrentUser() user: User, @Req() req: Request) {
    const review = await this.reviews.upsert(id, user.id, body);
    this.analytics.track('review', user.id, {
      ...baseProps({ userId: user.id }, analyticsFromRequest(req)),
      toilet_id: id,
      photos: body.photoIds?.length ?? 0,
    });
    return review;
  }
}
