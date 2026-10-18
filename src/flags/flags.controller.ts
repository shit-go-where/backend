import { Body, Controller, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ZodResponse, createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { User } from '../generated/prisma/client.js';
import { AuthGuard, CurrentUser } from '../common/auth/auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const CreateFlagSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export class CreateFlagDto extends createZodDto(CreateFlagSchema) {}
export class FlagCreatedDto extends createZodDto(z.object({ id: z.string() })) {}

@ApiTags('flags')
@Controller('toilets/:id/flags')
export class FlagsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @UseGuards(AuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiCookieAuth('sgw_session')
  @ZodResponse({ status: 201, type: FlagCreatedDto })
  async create(@Param('id') id: string, @Body() body: CreateFlagDto, @CurrentUser() user: User) {
    const toilet = await this.prisma.toilet.findUnique({ where: { id }, select: { id: true } });
    if (!toilet) throw new NotFoundException('Toilet not found');
    const flag = await this.prisma.flag.create({
      data: { toiletId: id, userId: user.id, reason: body.reason },
      select: { id: true },
    });
    return flag;
  }
}
