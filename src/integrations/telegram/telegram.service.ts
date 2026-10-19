import { Injectable, Logger } from '@nestjs/common';
import { Bot, type NextFunction } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { env } from '../../config/env.js';
import { DailyLimiter } from '../../common/throttle.js';
import { sgtDayNumber } from '../../gamification/sgt.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RecommendService } from '../../routing/recommend.service.js';
import { OneMapService } from '../../routing/onemap.service.js';
import { RouteCountService } from '../../routing/route-count.service.js';
import { GamificationService } from '../../gamification/gamification.service.js';
import { StatusService } from '../../status/status.service.js';
import { AnalyticsService } from '../../analytics/analytics.service.js';
import { ChatsService, chatTypeOf } from './chats.service.js';
import { ALLOWED_UPDATES, COPY, errorText } from './format.js';
import { mapUrl } from './links.js';
import { HTML, isGroupChat, type BotContext, type BotDeps } from './handlers/context.js';
import { registerGroup } from './handlers/group.js';
import { registerStart, registerStop } from './handlers/start.js';
import { registerGo } from './handlers/go.js';
import { registerFilters } from './handlers/filters.js';
import { registerLocation } from './handlers/location.js';
import { registerCallbacks } from './handlers/callbacks.js';
import { registerText } from './handlers/text.js';

/** Per-chat limits (BOT.md §4, §6 Operations). Telegram's own IPs are never throttled. */
export const CHAT_LIMITS = {
  private: { perMinute: 20, perDay: 300 },
  group: { perMinute: 10, perDay: 200 },
} as const;
/** Per chat per Singapore day, same numbers as the anonymous web path. */
export const CHECK_INS_PER_CHAT = 5;
export const REPORTS_PER_CHAT = 10;


export type LimitResult = { ok: true } | { ok: false; reason: 'minute' | 'day'; notify: boolean };

/**
 * Fixed windows per chat: a minute and a Singapore day. Over the limit, the chat is told once per
 * window and then ignored until the window turns. In memory per instance, like the API's limiter.
 */
export class ChatLimiter {
  private readonly minute: DailyLimiter;
  private readonly day: DailyLimiter;
  private readonly minuteNotice = new DailyLimiter(1);
  private readonly dayNotice = new DailyLimiter(1);

  constructor(perMinute: number, perDay: number) {
    this.minute = new DailyLimiter(perMinute);
    this.day = new DailyLimiter(perDay);
  }

  take(key: string, now: Date): LimitResult {
    const minute = Math.floor(now.getTime() / 60_000);
    const day = sgtDayNumber(now);
    if (!this.minute.take(key, minute)) return { ok: false, reason: 'minute', notify: this.minuteNotice.take(key, minute) };
    if (!this.day.take(key, day)) return { ok: false, reason: 'day', notify: this.dayNotice.take(key, day) };
    return { ok: true };
  }
}

/**
 * The bot's identity without a getMe call on every cold start: the numeric id is the token's prefix
 * and the username comes from TELEGRAM_BOT_USERNAME. grammY uses it to match `/cmd@username`.
 */
export function botInfoFor(token: string, username: string): UserFromGetMe {
  const id = Number(token.split(':')[0]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('TELEGRAM_BOT_TOKEN does not look like a bot token');
  return {
    id,
    is_bot: true,
    first_name: 'Shit Go Where',
    username: username.replace(/^@/, ''),
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
}

/** Update kinds for logs: never the message text or anything else a person typed. */
export const updateKind = (u: object) =>
  Object.keys(u)
    .filter((k) => k !== 'update_id')
    .join(',') || 'unknown';

/**
 * Builds the grammY bot, registers the handlers and owns the per-chat limiters (BOT.md §6).
 * Only provided when TELEGRAM_BOT_TOKEN is set (see TelegramModule).
 */
@Injectable()
export class TelegramService {
  private readonly log = new Logger(TelegramService.name);
  readonly bot: Bot<BotContext>;
  private readonly privateLimiter = new ChatLimiter(CHAT_LIMITS.private.perMinute, CHAT_LIMITS.private.perDay);
  private readonly groupLimiter = new ChatLimiter(CHAT_LIMITS.group.perMinute, CHAT_LIMITS.group.perDay);

  constructor(
    prisma: PrismaService,
    chats: ChatsService,
    recommend: RecommendService,
    onemap: OneMapService,
    routeCounts: RouteCountService,
    gamification: GamificationService,
    status: StatusService,
    analytics: AnalyticsService,
  ) {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    const username = env.TELEGRAM_BOT_USERNAME ?? null;
    this.bot = new Bot<BotContext>(token, {
      botInfo: username ? botInfoFor(token, username) : undefined,
      client: env.TELEGRAM_API_ROOT ? { apiRoot: env.TELEGRAM_API_ROOT.replace(/\/+$/, '') } : undefined,
    });
    const deps: BotDeps = {
      prisma,
      chats,
      recommend,
      onemap,
      routeCounts,
      gamification,
      status,
      analytics,
      appBase: env.PUBLIC_APP_URL,
      botUsername: username,
      checkInsPerChat: new DailyLimiter(CHECK_INS_PER_CHAT),
      reportsPerChat: new DailyLimiter(REPORTS_PER_CHAT),
      log: this.log,
    };
    this.register(deps);
  }

  private register(deps: BotDeps): void {
    const bot = this.bot;
    bot.use((ctx, next) => this.errorBoundary(ctx, next, deps));
    bot.use((ctx, next) => this.limit(ctx, next));
    // These two must not create a chat row: they run before it is loaded.
    registerGroup(bot, deps);
    registerStop(bot, deps);
    bot.use(async (ctx, next) => {
      ctx.chatRow = await deps.chats.load(ctx.chat!.id, chatTypeOf(ctx.chat!.type));
      await next();
    });
    registerStart(bot, deps);
    registerGo(bot, deps);
    registerFilters(bot);
    registerLocation(bot, deps);
    registerCallbacks(bot, deps);
    // Last: any text that was not a command above is a place search.
    registerText(bot, deps);
  }

  /** Handler errors are logged by update kind and answered politely; Telegram always gets its 200. */
  private async errorBoundary(ctx: BotContext, next: NextFunction, deps: BotDeps): Promise<void> {
    try {
      await next();
    } catch (e) {
      this.log.error(`telegram ${updateKind(ctx.update)} failed: ${(e as Error).message}`);
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
      if (ctx.chat && (ctx.message || ctx.callbackQuery)) {
        await ctx.reply(errorText(mapUrl(deps.appBase, 'start')), HTML).catch(() => undefined);
      }
    }
  }

  private async limit(ctx: BotContext, next: NextFunction): Promise<void> {
    const chat = ctx.chat;
    // No chat (e.g. inline queries, not in v1) or a channel post: nothing to answer.
    if (!chat || chat.type === 'channel') return;
    const limiter = isGroupChat(ctx) ? this.groupLimiter : this.privateLimiter;
    const r = limiter.take(String(chat.id), new Date());
    if (r.ok) return next();
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
    if (r.notify) await ctx.reply(r.reason === 'minute' ? COPY.slowDown : COPY.dailyLimit, HTML).catch(() => undefined);
  }

  /** One webhook update. Resolves when every reply has been sent (Vercel freezes after the response). */
  async handleUpdate(update: Update): Promise<void> {
    if (!this.bot.isInited()) await this.bot.init();
    await this.bot.handleUpdate(update);
  }

  /** Long polling for local dev (`pnpm cli telegram:poll`). Resolves when stopped. */
  async startPolling(onStart?: (username: string) => void): Promise<void> {
    await this.bot.start({
      allowed_updates: [...ALLOWED_UPDATES],
      onStart: (me) => onStart?.(me.username),
    });
  }

  async stopPolling(): Promise<void> {
    await this.bot.stop();
  }
}
