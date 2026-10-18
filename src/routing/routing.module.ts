import { Module } from '@nestjs/common';
import { ToiletsModule } from '../toilets/toilets.module.js';
import { GeoController, RoutingController } from './routing.controller.js';
import { OneMapService } from './onemap.service.js';
import { RecommendService } from './recommend.service.js';

@Module({
  imports: [ToiletsModule],
  controllers: [RoutingController, GeoController],
  providers: [OneMapService, RecommendService],
  exports: [OneMapService, RecommendService],
})
export class RoutingModule {}
