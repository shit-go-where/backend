import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { PrismaModule } from './prisma/prisma.module.js';
import { PointsModule } from './gamification/points.module.js';
import { HealthController } from './health/health.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { VenuesModule } from './venues/venues.module.js';
import { ToiletsModule } from './toilets/toilets.module.js';
import { RoutingModule } from './routing/routing.module.js';
import { SubmissionsModule } from './submissions/submissions.module.js';
import { ReviewsModule } from './reviews/reviews.module.js';
import { StatusModule } from './status/status.module.js';
import { FlagsModule } from './flags/flags.module.js';
import { MediaModule } from './media/media.module.js';
import { GamificationModule } from './gamification/gamification.module.js';
import { AdminModule } from './admin/admin.module.js';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    PointsModule,
    AuthModule,
    UsersModule,
    VenuesModule,
    ToiletsModule,
    RoutingModule,
    SubmissionsModule,
    ReviewsModule,
    StatusModule,
    FlagsModule,
    MediaModule,
    GamificationModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
