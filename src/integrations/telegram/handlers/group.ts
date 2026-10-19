/**
 * Groups (BOT.md §4). Privacy mode stays on, so the bot only sees commands and replies to its own
 * messages. Group behaviour of the commands lives with each command (/toilet in text.ts, /go in
 * go.ts, location redirect in location.ts); this file handles the bot joining and leaving.
 */
import type { Bot } from 'grammy';
import { HTML, type BotContext, type BotDeps } from './context.js';
import { groupHelpText } from '../format.js';

/** Registered before the chat row is loaded, so leaving a group never re-creates its row. */
export function registerGroup(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.on('my_chat_member', async (ctx) => {
    const chat = ctx.chat;
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === 'left' || status === 'kicked') {
      // Removed from a group, or blocked in a private chat: forget the chat, same as /stop.
      await deps.chats.remove(chat.id);
      return;
    }
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;
    const was = ctx.myChatMember.old_chat_member.status;
    if ((was === 'left' || was === 'kicked') && (status === 'member' || status === 'administrator')) {
      await ctx.reply(groupHelpText(), HTML);
    }
  });
}
