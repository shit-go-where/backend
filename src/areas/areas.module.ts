import { Module } from '@nestjs/common';
import { ToiletsModule } from '../toilets/toilets.module.js';
import { AreasController } from './areas.controller.js';
import { AreasService } from './areas.service.js';

@Module({
  imports: [ToiletsModule],
  controllers: [AreasController],
  providers: [AreasService],
})
export class AreasModule {}
