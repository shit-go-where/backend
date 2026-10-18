import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { AdminController, AdminJobsController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { CronSecretGuard } from './cron-secret.guard.js';

@Module({
  imports: [MediaModule],
  controllers: [AdminJobsController, AdminController],
  providers: [AdminService, CronSecretGuard],
})
export class AdminModule {}
