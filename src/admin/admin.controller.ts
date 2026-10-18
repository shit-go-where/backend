import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '../common/throttle.js';
import { ZodResponse } from 'nestjs-zod';
import { CurrentUser, MinRole, RolesGuard } from '../common/auth/auth.guard.js';
import type { User } from '../generated/prisma/client.js';
import { Role } from '../generated/prisma/enums.js';
import {
  AdminFlagListDto,
  AdminToiletPatchDto,
  DataQualityDto,
  FlagsQueryDto,
  AdminIdDto,
  ImportRunListDto,
  JOB_NAMES,
  JobResultDto,
  AdminOkDto,
  PendingPhotoListDto,
  PhotoApprovalDto,
  RolePatchDto,
  RoleResultDto,
  type JobName,
} from './admin.dto.js';
import { AdminService } from './admin.service.js';
import { CronSecretGuard } from './cron-secret.guard.js';

@ApiTags('admin')
@ApiCookieAuth()
@UseGuards(RolesGuard)
@MinRole(Role.MODERATOR)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('flags')
  @ZodResponse({ type: AdminFlagListDto })
  flags(@Query() q: FlagsQueryDto) {
    return this.admin.listFlags(q.resolved);
  }

  @Post('flags/:id/resolve')
  @HttpCode(200)
  @ZodResponse({ type: AdminOkDto })
  resolveFlag(@Param('id') id: string) {
    return this.admin.resolveFlag(id);
  }

  @Get('photos/pending')
  @MinRole(Role.TRUSTED)
  @ZodResponse({ type: PendingPhotoListDto })
  pendingPhotos() {
    return this.admin.pendingPhotos();
  }

  @Post('photos/:id/approve')
  @HttpCode(200)
  @MinRole(Role.TRUSTED)
  @ZodResponse({ type: PhotoApprovalDto })
  approvePhoto(@CurrentUser() user: User, @Param('id') id: string) {
    return this.admin.approvePhoto(user, id);
  }

  @Post('photos/:id/reject')
  @HttpCode(200)
  @ZodResponse({ type: AdminOkDto })
  rejectPhoto(@Param('id') id: string) {
    return this.admin.rejectPhoto(id);
  }

  @Patch('toilets/:id')
  @ZodResponse({ type: AdminIdDto })
  patchToilet(@Param('id') id: string, @Body() body: AdminToiletPatchDto) {
    return this.admin.patchToilet(id, body);
  }

  @Patch('users/:id/role')
  @MinRole(Role.ADMIN)
  @ZodResponse({ type: RoleResultDto })
  setRole(@CurrentUser() user: User, @Param('id') id: string, @Body() body: RolePatchDto) {
    return this.admin.setRole(user, id, body.role);
  }

  @Get('imports')
  @ZodResponse({ type: ImportRunListDto })
  imports() {
    return this.admin.listImports();
  }

  @Get('data-quality')
  @ZodResponse({ type: DataQualityDto })
  dataQuality() {
    return this.admin.dataQuality();
  }
}

/** Maintenance jobs for GitHub Actions cron. Guarded only by the shared secret header. */
@ApiTags('admin')
@SkipThrottle()
@UseGuards(CronSecretGuard)
@Controller('admin/jobs')
export class AdminJobsController {
  constructor(private readonly admin: AdminService) {}

  @Post(':name')
  @HttpCode(200)
  @ApiHeader({ name: 'x-cron-secret', required: true })
  @ZodResponse({ type: JobResultDto })
  run(@Param('name') name: string) {
    if (!(JOB_NAMES as readonly string[]).includes(name)) {
      throw new NotFoundException(`Unknown job. Use one of: ${JOB_NAMES.join(', ')}`);
    }
    return this.admin.runJob(name as JobName);
  }
}
