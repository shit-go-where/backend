import { Module } from '@nestjs/common';
import { GamificationController } from './gamification.controller.js';
import { GamificationService } from './gamification.service.js';

/** Check-ins, verification, badges, passport, user leaderboard. PointsService is global (PointsModule). */
@Module({
  controllers: [GamificationController],
  providers: [GamificationService],
  exports: [GamificationService],
})
export class GamificationModule {}
