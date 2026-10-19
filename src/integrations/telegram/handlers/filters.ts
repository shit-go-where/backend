/** T8 /filters: inline toggles for the hard filters, saved on TelegramChat and applied to every query. */
import type { Bot } from 'grammy';
import { chatRow, HTML, type BotContext, type BotDeps } from './context.js';
import { filtersMessage, toggleFilter, type FilterKey } from '../format.js';
import { filterStateOf } from '../chats.service.js';

/** `f:<key>` callback: flip one filter and redraw the message in place. */
export async function onFilterToggle(ctx: BotContext, deps: BotDeps, key: FilterKey): Promise<void> {
  const next = toggleFilter(filterStateOf(chatRow(ctx)), key);
  await deps.chats.setFilters(ctx.chat!.id, next);
  const { text, keyboard } = filtersMessage(next);
  await ctx.answerCallbackQuery();
  // "message is not modified" (a double tap) is harmless.
  await ctx.editMessageText(text, { ...HTML, reply_markup: keyboard }).catch(() => undefined);
}

export function registerFilters(bot: Bot<BotContext>): void {
  bot.command('filters', async (ctx) => {
    const { text, keyboard } = filtersMessage(filterStateOf(chatRow(ctx)));
    await ctx.reply(text, { ...HTML, reply_markup: keyboard });
  });
}
