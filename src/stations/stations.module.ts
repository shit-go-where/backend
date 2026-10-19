import { Module } from '@nestjs/common';
import { ToiletsModule } from '../toilets/toilets.module.js';
import { StationsController } from './stations.controller.js';
import { StationsService } from './stations.service.js';

@Module({
  imports: [ToiletsModule],
  controllers: [StationsController],
  providers: [StationsService],
})
export class StationsModule {}
