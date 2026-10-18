import { Module } from '@nestjs/common';
import { ToiletLeaderboardController, ToiletsController } from './toilets.controller.js';
import { ToiletsService } from './toilets.service.js';
import { ToiletPresenter } from './toilet-presenter.service.js';

@Module({
  controllers: [ToiletsController, ToiletLeaderboardController],
  providers: [ToiletsService, ToiletPresenter],
  exports: [ToiletsService, ToiletPresenter],
})
export class ToiletsModule {}
