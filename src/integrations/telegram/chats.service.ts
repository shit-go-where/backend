import { Injectable } from '@nestjs/common';
import type { TelegramChat } from '../../generated/prisma/client.js';
import type { TelegramChatType } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { FilterState } from './format.js';
import { hashLinkToken } from './identity.js';

/** `lastSeenAt` is written at most this often (BOT.md §6), so a busy chat costs one read per update. */
export const TOUCH_INTERVAL_MS = 3_600_000;
/** /go: how long the next location counts as urgent (T4). */
export const URGENT_WINDOW_MS = 2 * 60_000;

/** Telegram's chat.type → our enum. */
export function chatTypeOf(type: string): TelegramChatType {
  switch (type) {
    case 'private':
      return 'PRIVATE';
    case 'group':
      return 'GROUP';
    case 'supergroup':
      return 'SUPERGROUP';
    default:
      return 'CHANNEL';
  }
}

export const needsTouch = (lastSeenAt: Date, now: Date) => now.getTime() - lastSeenAt.getTime() >= TOUCH_INTERVAL_MS;

/** The next location ranks urgent: /go was sent less than 2 minutes ago. */
export const isUrgent = (chat: Pick<TelegramChat, 'urgentUntil'>, now: Date) =>
  chat.urgentUntil !== null && chat.urgentUntil.getTime() > now.getTime();

export const filterStateOf = (chat: Pick<TelegramChat, 'filters' | 'areaType' | 'openNow'>): FilterState => ({
  filters: chat.filters,
  areaType: chat.areaType,
  openNow: chat.openNow,
});

/**
 * TelegramChat reads and writes (BOT.md B3). One row per chat: id, type, pending urgent mode,
 * saved filters, linked account, timestamps. Nothing else about the person.
 */
@Injectable()
export class ChatsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The chat's row, created on first contact; `lastSeenAt` refreshed at most once an hour. */
  async load(chatId: number, type: TelegramChatType, now = new Date()): Promise<TelegramChat> {
    const id = BigInt(chatId);
    const row = await this.prisma.telegramChat.findUnique({ where: { chatId: id } });
    if (!row) {
      return this.prisma.telegramChat.upsert({
        where: { chatId: id },
        create: { chatId: id, type, createdAt: now, lastSeenAt: now },
        update: { lastSeenAt: now },
      });
    }
    if (needsTouch(row.lastSeenAt, now) || row.type !== type) {
      return this.prisma.telegramChat.update({ where: { chatId: id }, data: { lastSeenAt: now, type } });
    }
    return row;
  }

  async setUrgentUntil(chatId: number, until: Date | null): Promise<void> {
    await this.prisma.telegramChat.updateMany({ where: { chatId: BigInt(chatId) }, data: { urgentUntil: until } });
  }

  async setFilters(chatId: number, s: FilterState): Promise<void> {
    await this.prisma.telegramChat.updateMany({
      where: { chatId: BigInt(chatId) },
      data: { filters: s.filters, areaType: s.areaType, openNow: s.openNow },
    });
  }

  /** /stop: forget the chat entirely. */
  async remove(chatId: number): Promise<void> {
    await this.prisma.telegramChat.deleteMany({ where: { chatId: BigInt(chatId) } });
  }

  /** /unlink. Returns whether the chat was linked. */
  async unlink(chatId: number): Promise<boolean> {
    const r = await this.prisma.telegramChat.updateMany({
      where: { chatId: BigInt(chatId), userId: { not: null } },
      data: { userId: null },
    });
    return r.count > 0;
  }

  /**
   * `/start link_<token>`: the user whose unexpired token this is, with the token cleared so it
   * cannot be used twice (the conditional update is the lock). Null when unknown or expired.
   */
  async consumeLinkToken(token: string, now = new Date()): Promise<{ id: string; handle: string | null } | null> {
    const hash = hashLinkToken(token);
    const user = await this.prisma.user.findFirst({
      where: { telegramLinkTokenHash: hash, telegramLinkTokenExpiresAt: { gt: now }, deletedAt: null },
      select: { id: true, handle: true },
    });
    if (!user) return null;
    const cleared = await this.prisma.user.updateMany({
      where: { id: user.id, telegramLinkTokenHash: hash },
      data: { telegramLinkTokenHash: null, telegramLinkTokenExpiresAt: null },
    });
    return cleared.count === 1 ? user : null;
  }

  /** Links this chat to the account; an account has at most one chat, so an older link moves here. */
  async link(chatId: number, type: TelegramChatType, userId: string, now = new Date()): Promise<void> {
    const id = BigInt(chatId);
    await this.prisma.$transaction([
      this.prisma.telegramChat.updateMany({ where: { userId, chatId: { not: id } }, data: { userId: null } }),
      this.prisma.telegramChat.upsert({
        where: { chatId: id },
        create: { chatId: id, type, userId, createdAt: now, lastSeenAt: now },
        update: { userId, lastSeenAt: now },
      }),
    ]);
  }
}
