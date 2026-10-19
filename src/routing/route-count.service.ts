import { Injectable, NotFoundException } from '@nestjs/common';
import { ToiletStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { sgtDateColumn } from '../gamification/sgt.js';

/**
 * Counts routes started per toilet per Singapore day (GROWTH.md 1.3), so contributors can hear
 * "N people were sent to toilets you helped". Only the count is stored, never who routed.
 */
@Injectable()
export class RouteCountService {
  constructor(private readonly prisma: PrismaService) {}

  async record(toiletId: string, now = new Date()): Promise<void> {
    const t = await this.prisma.toilet.findUnique({ where: { id: toiletId }, select: { status: true } });
    if (!t || t.status !== ToiletStatus.ACTIVE) throw new NotFoundException('Toilet not found');
    const day = sgtDateColumn(now);
    await this.prisma.toiletRouteDaily.upsert({
      where: { toiletId_day: { toiletId, day } },
      create: { toiletId, day, count: 1 },
      update: { count: { increment: 1 } },
    });
  }
}
