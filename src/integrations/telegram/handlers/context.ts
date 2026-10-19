/** Types and small helpers shared by the bot's handlers. */
import type { Logger } from '@nestjs/common';
import { Keyboard, type Context } from 'grammy';
import type { TelegramChat } from '../../../generated/prisma/client.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import type { RecommendService } from '../../../routing/recommend.service.js';
import type { OneMapService } from '../../../routing/onemap.service.js';
import type { RouteCountService } from '../../../routing/route-count.service.js';
import type { GamificationService } from '../../../gamification/gamification.service.js';
import type { StatusService } from '../../../status/status.service.js';
import type { AnalyticsService } from '../../../analytics/analytics.service.js';
import type { DailyLimiter } from '../../../common/throttle.js';
import type { ChatsService } from '../chats.service.js';
import { deviceIdFor } from '../identity.js';

/** grammY context plus this chat's TelegramChat row (loaded by middleware before any handler). */
export interface BotContext extends Context {
  chatRow?: TelegramChat;
}

export interface BotDeps {
  prisma: PrismaService;
  chats: ChatsService;
  recommend: RecommendService;
  onemap: OneMapService;
  routeCounts: RouteCountService;
  gamification: GamificationService;
  status: StatusService;
  analytics: AnalyticsService;
  /** Frontend origin for app links (PUBLIC_APP_URL). */
  appBase: string;
  /** Bot username for t.me deep links; null when not configured. */
  botUsername: string | null;
  /** Per chat per Singapore day (BOT.md §6 Operations). */
  checkInsPerChat: DailyLimiter;
  reportsPerChat: DailyLimiter;
  log: Logger;
}

export const isGroupChat = (ctx: Context) => ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

/** The row the middleware loaded. Every handler runs after it, so a missing row is a bug. */
export function chatRow(ctx: BotContext): TelegramChat {
  if (!ctx.chatRow) throw new Error('chat row not loaded');
  return ctx.chatRow;
}

/** This chat's contribution device id (unprefixed hashTelegramId, BOT.md §10). */
export const chatDeviceId = (ctx: Context, deps: Pick<BotDeps, 'analytics'>) => deviceIdFor(deps.analytics, ctx.chat!.id);

/** Every reply: HTML, no link previews (they would expand the map links into big cards). */
export const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;

export const LOCATION_BUTTON = '📍 Send my location';
export const PLACE_BUTTON = '🔎 Type a place';

/** The one-tap keyboard (T1). "Type a place" is for desktop Telegram, which cannot share a location. */
export function locationKeyboard(): Keyboard {
  return new Keyboard().requestLocation(LOCATION_BUTTON).row().text(PLACE_BUTTON).resized().persistent();
}
