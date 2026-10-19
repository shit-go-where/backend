/** T4 urgent mode: /go makes the next location (within 2 minutes) rank by walk time, hard filters only. */
import { InlineKeyboard, type Bot } from 'grammy';
import { HTML, isGroupChat, locationKeyboard, type BotContext, type BotDeps } from './context.js';
import { COPY } from '../format.js';
import { URGENT_WINDOW_MS } from '../chats.service.js';
import { botDeepLink } from '../links.js';

export async function startUrgent(ctx: BotContext, deps: BotDeps): Promise<void> {
  await deps.chats.setUrgentUntil(ctx.chat!.id, new Date(Date.now() + URGENT_WINDOW_MS));
  await ctx.reply(COPY.goPrivate, { ...HTML, reply_markup: locationKeyboard() });
}

export function registerGo(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.command('go', async (ctx) => {
    if (isGroupChat(ctx)) {
      // Sharing a live location into a group shows it to everyone: hand over to a private chat (§4).
      const kb = deps.botUsername
        ? new InlineKeyboard().url('🚨 Find near me', botDeepLink(deps.botUsername, 'go'))
        : undefined;
      await ctx.reply(COPY.goGroup, { ...HTML, reply_markup: kb });
      return;
    }
    await startUrgent(ctx, deps);
  });
}
