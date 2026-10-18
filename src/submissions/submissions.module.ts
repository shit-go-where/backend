import { Module } from '@nestjs/common';
import { GamificationModule } from '../gamification/gamification.module.js';
import { ToiletsModule } from '../toilets/toilets.module.js';
import { SubmissionsController } from './submissions.controller.js';
import { SubmissionsService } from './submissions.service.js';

/** Crowd-sourced NEW_TOILET / EDIT_TOILET / CLOSE_TOILET submissions with peer voting. */
@Module({
  imports: [GamificationModule, ToiletsModule],
  controllers: [SubmissionsController],
  providers: [SubmissionsService],
  exports: [SubmissionsService],
})
export class SubmissionsModule {}
