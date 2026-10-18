import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { Role } from '../generated/prisma/enums.js';
import type { Me } from './users.dto.js';

/** Handles nobody may claim (impersonation of staff / the app). */
export const RESERVED_HANDLES = new Set([
  'admin',
  'admins',
  'administrator',
  'moderator',
  'moderators',
  'mod',
  'mods',
  'staff',
  'support',
  'help',
  'system',
  'root',
  'sgw',
  'shitgowhere',
  'shit_go_where',
  'official',
  'anonymous',
  'deleted',
  'deleted_user',
  'null',
  'undefined',
  'me',
]);

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase());
}

export const DELETED_EMAIL_DOMAIN = 'deleted.invalid';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string): Promise<Me> {
    const [user, points] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: { badges: { include: { badge: true }, orderBy: { awardedAt: 'asc' } } },
      }),
      this.prisma.pointsLedger.aggregate({ where: { userId }, _sum: { delta: true } }),
    ]);
    if (!user) throw new NotFoundException('User not found');
    return {
      id: user.id,
      email: user.email,
      handle: user.handle,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role,
      trustScore: user.trustScore,
      leaderboardOptIn: user.leaderboardOptIn,
      points: points._sum.delta ?? 0,
      badges: user.badges.map((ub) => ({
        id: ub.badge.id,
        name: ub.badge.name,
        description: ub.badge.description,
        icon: ub.badge.icon,
        awardedAt: ub.awardedAt.toISOString(),
      })),
      needsHandle: user.handle === null,
    };
  }

  async updateMe(
    userId: string,
    patch: { handle?: string; displayName?: string; leaderboardOptIn?: boolean },
  ): Promise<Me> {
    if (patch.handle !== undefined) {
      if (isReservedHandle(patch.handle)) throw new ConflictException('Handle is not available');
      const taken = await this.prisma.user.findUnique({
        where: { handle: patch.handle },
        select: { id: true },
      });
      if (taken && taken.id !== userId) throw new ConflictException('Handle is already taken');
    }
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          handle: patch.handle,
          displayName: patch.displayName,
          leaderboardOptIn: patch.leaderboardOptIn,
        },
      });
    } catch (e) {
      // Race between the check above and the write.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Handle is already taken');
      }
      throw e;
    }
    return this.getMe(userId);
  }

  /**
   * PDPA deletion. Personal data is removed; contributions (reviews, submissions, votes, photos,
   * status reports, flags) stay but point at an anonymous "Deleted user" with no handle.
   */
  async deleteMe(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.checkIn.deleteMany({ where: { userId } }),
      this.prisma.pointsLedger.deleteMany({ where: { userId } }),
      this.prisma.userBadge.deleteMany({ where: { userId } }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          email: `deleted-${userId}@${DELETED_EMAIL_DOMAIN}`,
          googleSub: null,
          handle: null,
          avatarUrl: null,
          displayName: 'Deleted user',
          leaderboardOptIn: false,
          role: Role.USER,
          trustScore: 0,
          deletedAt: new Date(),
        },
      }),
    ]);
  }

  async activity(userId: string, opts: { cursor?: string; limit: number }) {
    const rows = await this.prisma.pointsLedger.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: { id: true, delta: true, reason: true, refId: true, createdAt: true },
    });
    const page = rows.slice(0, opts.limit);
    return {
      items: page.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      nextCursor: rows.length > opts.limit ? page[page.length - 1].id : null,
    };
  }
}
