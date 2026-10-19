/** T1 /start onboarding, T10 /help /privacy /stop, T15 /start link_<token> and /unlink. */
import type { Bot } from 'grammy';
import { chatRow, chatDeviceId, HTML, isGroupChat, locationKeyboard, type BotContext, type BotDeps } from './context.js';
import { COPY, groupHelpText, helpText, linkedText, privacyText, startText } from '../format.js';
import { mapUrl, privacyUrl } from '../links.js';
import { parseLinkPayload } from '../identity.js';
import { chatTypeOf } from '../chats.service.js';
import { startUrgent } from './go.js';

/** T15: verify the one-time token, link the chat, move the chat's anonymous points to the account. */
async function linkAccount(ctx: BotContext, deps: BotDeps, token: string): Promise<void> {
  if (isGroupChat(ctx)) {
    await ctx.reply(COPY.privateOnly, HTML);
    return;
  }
  const user = await deps.chats.consumeLinkToken(token);
  if (!user) {
    await ctx.reply(COPY.linkExpired, HTML);
    return;
  }
  await deps.chats.link(ctx.chat!.id, chatTypeOf(ctx.chat!.type), user.id);
  const merged = await deps.gamification.mergeDevice(user.id, chatDeviceId(ctx, deps));
  await ctx.reply(linkedText(user.handle, merged.points), { ...HTML, reply_markup: locationKeyboard() });
}

/** /stop runs before the chat row is loaded, so it never re-creates the row it deletes. */
export function registerStop(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.command('stop', async (ctx) => {
    await deps.chats.remove(ctx.chat.id);
    await ctx.reply(COPY.stopped, {
      ...HTML,
      reply_markup: isGroupChat(ctx) ? undefined : { remove_keyboard: true },
    });
  });
}

export function registerStart(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.command('start', async (ctx) => {
    const payload = ctx.match.trim();
    const token = parseLinkPayload(payload);
    if (token) return linkAccount(ctx, deps, token);
    if (payload.startsWith('link_')) {
      await ctx.reply(COPY.linkExpired, HTML);
      return;
    }
    if (isGroupChat(ctx)) {
      await ctx.reply(groupHelpText(), HTML);
      return;
    }
    // `/start go` comes from the group /go button: straight into urgent mode.
    if (payload === 'go') return startUrgent(ctx, deps);
    if (payload === 'near') {
      await ctx.reply(COPY.askLocation, { ...HTML, reply_markup: locationKeyboard() });
      return;
    }
    await ctx.reply(startText(), { ...HTML, reply_markup: locationKeyboard() });
  });

  bot.command('help', async (ctx) => {
    if (isGroupChat(ctx)) {
      await ctx.reply(groupHelpText(), HTML);
      return;
    }
    await ctx.reply(helpText(mapUrl(deps.appBase, 'help')), { ...HTML, reply_markup: locationKeyboard() });
  });

  bot.command('privacy', async (ctx) => {
    await ctx.reply(privacyText(privacyUrl(deps.appBase)), HTML);
  });

  bot.command('unlink', async (ctx) => {
    if (isGroupChat(ctx)) {
      await ctx.reply(COPY.privateOnly, HTML);
      return;
    }
    const was = chatRow(ctx).userId !== null && (await deps.chats.unlink(ctx.chat.id));
    await ctx.reply(was ? COPY.unlinked : COPY.notLinked, HTML);
  });
}
