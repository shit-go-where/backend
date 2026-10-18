import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import type { User } from '../generated/prisma/client.js';
import { AuthGuard, CurrentUser } from '../common/auth/auth.guard.js';
import { ReviewsService } from './reviews.service.js';
import { CreateReviewDto, ReviewDto, ReviewListQueryDto, ReviewPageDto } from './reviews.dto.js';

@ApiTags('reviews')
@Controller('toilets/:id/reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @ZodResponse({ status: 200, type: ReviewPageDto })
  list(@Param('id') id: string, @Query() q: ReviewListQueryDto) {
    return this.reviews.list(id, q.cursor, q.limit);
  }

  @Post()
  @UseGuards(AuthGuard)
  @ApiCookieAuth('sgw_session')
  @ZodResponse({ status: 201, type: ReviewDto })
  create(@Param('id') id: string, @Body() body: CreateReviewDto, @CurrentUser() user: User) {
    return this.reviews.upsert(id, user.id, body);
  }
}
