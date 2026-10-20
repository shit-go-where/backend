import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse, createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { SkipThrottle } from '../common/throttle.js';
import { PrismaService } from '../prisma/prisma.service.js';

export class LivenessDto extends createZodDto(
  z.object({
    ok: z.literal(true),
    /** Deployed git SHA (VERCEL_GIT_COMMIT_SHA); null outside Vercel. */
    commit: z.string().nullable(),
    time: z.string(),
  }),
) {}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Readiness: the database answers. Wakes Neon's compute, so probe it sparingly. */
  @Get()
  async health() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true, db: 'up', time: new Date().toISOString() };
    } catch {
      throw new ServiceUnavailableException({ ok: false, db: 'down' });
    }
  }

  /**
   * Liveness for uptime monitors (AUDIT I-04): never touches the database, so a probe does not keep
   * Neon awake, and reports which commit is deployed. Not throttled: monitors share egress IPs.
   */
  @Get('live')
  @SkipThrottle()
  @Header('Cache-Control', 'no-store')
  @ZodResponse({ status: 200, type: LivenessDto })
  live() {
    return {
      ok: true as const,
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
      time: new Date().toISOString(),
    };
  }
}
