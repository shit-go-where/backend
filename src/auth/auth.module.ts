import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { GamificationModule } from '../gamification/gamification.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

@Module({
  // GamificationModule: merging anonymous check-ins on sign-in pays their points and badges.
  imports: [UsersModule, GamificationModule],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
