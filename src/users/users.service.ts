import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { Role, SubmissionState } from '../generated/prisma/enums.js';
import { hasRole } from '../common/auth/auth.guard.js';
import { TRUSTED_THRESHOLD } from '../gamification/points.service.js';
import { sgtDateColumn } from '../gamification/sgt.js';
import { MAX_OPEN_SUBMISSIONS, openSubmissionsWhere } from '../submissions/resolution.js';
import type { Me } from './users.dto.js';
import { LINK_PAYLOAD_PREFIX, newLinkToken } from '../integrations/telegram/identity.js';
import { botDeepLink } from '../integrations/telegram/links.js';

/** A handle that is already set can be changed once in this window. */
export const HANDLE_CHANGE_INTERVAL_MS = 30 * 86_400_000;
/** Check-ins this recent make a toilet one you "helped" for the impact counts. */
export const IMPACT_CHECK_IN_WINDOW_MS = 90 * 86_400_000;

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
/** Replaces the text of a deleted account's resolved flags. */
export const DELETED_FLAG_REASON = 'Removed: the reporter deleted their account';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string): Promise<Me> {
    const [user, points, openCount] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          badges: { include: { badge: true }, orderBy: { awardedAt: 'asc' } },
          telegramChat: { select: { userId: true } },
        },
      }),
      this.prisma.pointsLedger.aggregate({ where: { userId }, _sum: { delta: true } }),
      this.prisma.submission.count({ where: openSubmissionsWhere(userId) }),
    ]);
    if (!user) throw new NotFoundException('User not found');
    const since = user.lastSeenActivityAt ?? user.createdAt;
    const [resolvedSubmissions, flagReplies, newPoints, impact] = await Promise.all([
      this.prisma.submission.count({
        where: {
          submittedById: userId,
          resolvedAt: { gt: since },
          state: { in: [SubmissionState.APPROVED, SubmissionState.REJECTED] },
          // Going live at once is not news: the submitter saw it happen.
          OR: [{ resolution: null }, { resolution: { not: 'auto_on_site_photo' } }],
        },
      }),
      this.prisma.flag.findMany({
        where: { userId, resolved: true, resolvedAt: { gt: since } },
        orderBy: { resolvedAt: 'desc' },
        take: 10,
        include: { toilet: { select: { id: true, label: true, venue: { select: { name: true } } } } },
      }),
      this.prisma.pointsLedger.aggregate({ where: { userId, createdAt: { gt: since } }, _sum: { delta: true } }),
      this.impact(userId, since),
    ]);
    const nextHandleChange =
      user.handle && user.handleChangedAt ? user.handleChangedAt.getTime() + HANDLE_CHANGE_INTERVAL_MS : 0;
    return {
      id: user.id,
      email: user.email,
      handle: user.handle,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role,
      trustScore: user.trustScore,
      leaderboardOptIn: user.leaderboardOptIn,
      verifierCredit: user.verifierCredit,
      points: points._sum.delta ?? 0,
      badges: user.badges.map((ub) => ({
        id: ub.badge.id,
        name: ub.badge.name,
        description: ub.badge.description,
        icon: ub.badge.icon,
        awardedAt: ub.awardedAt.toISOString(),
      })),
      needsHandle: user.handle === null,
      handleAuto: user.handleAuto,
      handleChangeableAt: nextHandleChange > Date.now() ? new Date(nextHandleChange).toISOString() : null,
      trust: { score: user.trustScore, threshold: TRUSTED_THRESHOLD, isTrusted: hasRole(user, Role.TRUSTED) },
      openSubmissions: { count: openCount, limit: MAX_OPEN_SUBMISSIONS },
      unseen: {
        resolvedSubmissions,
        resolvedFlags: flagReplies.length,
        badges: user.badges.filter((b) => b.awardedAt > since).length,
        points: newPoints._sum.delta ?? 0,
        routed: impact.routedSince,
      },
      flagReplies: flagReplies.map((f) => ({
        id: f.id,
        toilet: { id: f.toilet.id, label: f.toilet.label, venueName: f.toilet.venue.name },
        reason: f.reason,
        note: f.resolutionNote,
        resolvedAt: f.resolvedAt!.toISOString(),
      })),
      impact: { toilets: impact.toilets, routedWeek: impact.routedWeek },
      lastSeenActivityAt: user.lastSeenActivityAt?.toISOString() ?? null,
      telegramLinked: user.telegramChat !== null,
    };
  }

  /**
   * Toilets this person helped (added, last verified, or checked in at within 90 days) and route
   * starts to them. Counts only: ToiletRouteDaily never records who routed.
   */
  private async impact(userId: string, since: Date, now = new Date()) {
    const helped = await this.prisma.toilet.findMany({
      where: {
        OR: [
          { createdById: userId },
          { lastVerifiedById: userId },
          { checkIns: { some: { userId, createdAt: { gte: new Date(now.getTime() - IMPACT_CHECK_IN_WINDOW_MS) } } } },
        ],
      },
      select: { id: true },
    });
    if (!helped.length) return { toilets: 0, routedWeek: 0, routedSince: 0 };
    const ids = helped.map((t) => t.id);
    const routedFrom = async (from: Date) =>
      (
        await this.prisma.toiletRouteDaily.aggregate({
          where: { toiletId: { in: ids }, day: { gte: sgtDateColumn(from) } },
          _sum: { count: true },
        })
      )._sum.count ?? 0;
    const [routedWeek, routedSince] = await Promise.all([
      routedFrom(new Date(now.getTime() - 6 * 86_400_000)),
      // Day resolution: the Singapore day after the last visit, so nothing already seen is counted again.
      routedFrom(new Date(since.getTime() + 86_400_000)),
    ]);
    return { toilets: ids.length, routedWeek, routedSince };
  }

  /**
   * Telegram account linking (BOT.md T15): a one-time token, stored as its SHA-256 hash for 10
   * minutes, inside a t.me deep link. The bot clears it on use. A new request replaces the old one.
   */
  async createTelegramLinkToken(userId: string, now = new Date()): Promise<{ url: string; expiresAt: string }> {
    const username = env.TELEGRAM_BOT_USERNAME;
    if (!env.TELEGRAM_BOT_TOKEN || !username) throw new ServiceUnavailableException('The Telegram bot is not set up');
    const { token, hash, expiresAt } = newLinkToken(now);
    await this.prisma.user.update({
      where: { id: userId },
      data: { telegramLinkTokenHash: hash, telegramLinkTokenExpiresAt: expiresAt },
    });
    return { url: botDeepLink(username, `${LINK_PAYLOAD_PREFIX}${token}`), expiresAt: expiresAt.toISOString() };
  }

  /** Unlinks whichever chat is linked (and drops any unused link token). Idempotent. */
  async unlinkTelegram(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.telegramChat.updateMany({ where: { userId }, data: { userId: null } }),
      this.prisma.user.update({
        where: { id: userId },
        data: { telegramLinkTokenHash: null, telegramLinkTokenExpiresAt: null },
      }),
    ]);
  }

  /** Clears the "since your last visit" counts in GET /me. */
  async markActivitySeen(userId: string): Promise<{ ok: true; seenAt: string }> {
    const now = new Date();
    await this.prisma.user.update({ where: { id: userId }, data: { lastSeenActivityAt: now } });
    return { ok: true, seenAt: now.toISOString() };
  }

  async updateMe(
    userId: string,
    patch: { handle?: string; displayName?: string; leaderboardOptIn?: boolean; verifierCredit?: boolean },
  ): Promise<Me> {
    let handleChanged = false;
    if (patch.handle !== undefined) {
      const current = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { handle: true, handleChangedAt: true, handleAuto: true },
      });
      // Choosing a first handle (or replacing the random one from sign-up) is free; changing one
      // you picked is allowed once every 30 days.
      handleChanged = Boolean(current?.handle) && !current?.handleAuto && current?.handle !== patch.handle;
      if (handleChanged && current?.handleChangedAt) {
        const next = current.handleChangedAt.getTime() + HANDLE_CHANGE_INTERVAL_MS;
        if (next > Date.now()) {
          const day = new Date(next).toLocaleDateString('en-SG', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            timeZone: 'Asia/Singapore',
          });
          throw new HttpException(
            `You can change your handle once every 30 days. You can change it again from ${day}.`,
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }
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
          // Sending a handle, even the random one, makes it yours.
          ...(patch.handle !== undefined ? { handleAuto: false } : {}),
          displayName: patch.displayName,
          leaderboardOptIn: patch.leaderboardOptIn,
          verifierCredit: patch.verifierCredit,
          ...(handleChanged ? { handleChangedAt: new Date() } : {}),
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
   * status reports, flags) stay but point at an anonymous "Deleted user" with no handle. Where the
   * person stood when submitting, their review-vote notes and the text of their resolved flags go
   * too (an open flag keeps its reason until a moderator has dealt with it).
   */
  async deleteMe(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.submission.updateMany({
        where: { submittedById: userId },
        data: { submittedLat: null, submittedLng: null },
      }),
      this.prisma.submissionVote.updateMany({ where: { userId }, data: { comment: null } }),
      this.prisma.flag.updateMany({ where: { userId, resolved: true }, data: { reason: DELETED_FLAG_REASON } }),
      this.prisma.checkIn.deleteMany({ where: { userId } }),
      this.prisma.pointsLedger.deleteMany({ where: { userId } }),
      this.prisma.userBadge.deleteMany({ where: { userId } }),
      // The account row stays (anonymised), so the Telegram link is cleared by hand.
      this.prisma.telegramChat.updateMany({ where: { userId }, data: { userId: null } }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          email: `deleted-${userId}@${DELETED_EMAIL_DOMAIN}`,
          googleSub: null,
          handle: null,
          handleAuto: false,
          avatarUrl: null,
          displayName: 'Deleted user',
          leaderboardOptIn: false,
          role: Role.USER,
          trustScore: 0,
          telegramLinkTokenHash: null,
          telegramLinkTokenExpiresAt: null,
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
