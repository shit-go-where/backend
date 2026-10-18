import { Global, Module } from '@nestjs/common';
import { PointsService } from './points.service.js';

/** Global so any feature module can award points without importing GamificationModule. */
@Global()
@Module({ providers: [PointsService], exports: [PointsService] })
export class PointsModule {}
