/**
 * Inline button taps (BOT.md §6 callback data): `u` closest only, `c` check in (T6), `r` status
 * report (T7), `f` filter toggle (T8). Coordinates live only in the callback data Telegram already
 * holds; nothing about them is written to the database.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { Bot } from 'grammy';
import type { User } from '../../../generated/prisma/client.js';
import type { StatusKind } from '../../../generated/prisma/enums.js';
import { sgtDayNumber } from '../../../gamification/sgt.js';
import { POINTS } from '../../../gamification/points.service.js';
import { chatRow, chatDeviceId, HTML, isGroupChat, locationKeyboard, type BotContext, type BotDeps } from './context.js';
import { replyWithToilets } from './location.js';
import { onFilterToggle } from './filters.js';
import {
  COPY,
  checkInExpired,
  checkInText,
  decodeCallback,
  minuteOf,
  nudgeText,
  reportText,
  shouldNudge,
  statusKeyboard,
  toiletTitle,
} from '../format.js';
import { TELEGRAM } from '../identity.js';

/** The linked account behind this chat, if it still exists. */
async function linkedUser(ctx: BotContext, deps: BotDeps): Promise<User | null> {
  const userId = chatRow(ctx).userId;
  if (!userId) return null;
  const user = await deps.prisma.user.findUnique({ where: { id: userId } });
  return user && !user.deletedAt ? user : null;
}

async function titleOf(deps: BotDeps, toiletId: string): Promise<string> {
  const t = await deps.prisma.toilet.findUnique({
    where: { id: toiletId },
    select: { label: true, level: true, venue: { select: { name: true, type: true } } },
  });
  return t ? toiletTitle(t) : 'this toilet';
}

/**
 * GROWTH 3.3 nudge for unlinked chats: after the 3rd contribution (then every 5th), say how many
 * points are banked. Approximate: first-at-this-toilet points are paid once per toilet on merge.
 */
async function nudgeFor(deps: BotDeps, deviceId: string): Promise<string | null> {
  const [checkIns, reports] = await Promise.all([
    deps.prisma.checkIn.findMany({ where: { deviceId, userId: null }, select: { toiletId: true } }),
    deps.prisma.statusReport.count({ where: { deviceId, userId: null } }),
  ]);
  if (!shouldNudge(checkIns.length + reports)) return null;
  const points =
    checkIns.length * POINTS.CHECK_IN + new Set(checkIns.map((c) => c.toiletId)).size * POINTS.FIRST_CHECK_IN_AT_TOILET;
  return points > 0 ? nudgeText(points) : null;
}

/** A service error in plain words, or null to rethrow (a real fault). */
function checkInErrorText(e: unknown): string | null {
  if (!(e instanceof HttpException)) return null;
  const msg = e.message;
  switch (e.getStatus()) {
    case HttpStatus.BAD_REQUEST:
      return /within \d+ m/.test(msg)
        ? `${msg}. Send your location when you're there and tap I'm here again.`
        : 'This toilet isn\'t taking check-ins right now.';
    case HttpStatus.UNAUTHORIZED:
      return COPY.pendingNeedsAccount;
    case HttpStatus.NOT_FOUND:
      return COPY.toiletGone;
    case HttpStatus.TOO_MANY_REQUESTS:
      return /times a day/.test(msg) ? COPY.checkInLimit : `${msg}.`;
    default:
      return null;
  }
}

async function onCheckIn(
  ctx: BotContext,
  deps: BotDeps,
  a: { toiletId: string; lat: number; lng: number; minute: number },
): Promise<void> {
  const now = new Date();
  if (checkInExpired(a.minute, now)) {
    await ctx.answerCallbackQuery({ text: 'That location is too old' });
    await ctx.reply(COPY.checkInStale, { ...HTML, reply_markup: locationKeyboard() });
    return;
  }
  if (!deps.checkInsPerChat.take(String(ctx.chat!.id), sgtDayNumber(now))) {
    await ctx.answerCallbackQuery({ text: 'Daily limit reached' });
    await ctx.reply(COPY.checkInLimit, HTML);
    return;
  }
  const user = await linkedUser(ctx, deps);
  const deviceId = chatDeviceId(ctx, deps);
  let result;
  try {
    result = user
      ? await deps.gamification.checkIn(user, a.toiletId, a.lat, a.lng, TELEGRAM)
      : await deps.gamification.anonymousCheckIn(deviceId, a.toiletId, a.lat, a.lng, TELEGRAM);
  } catch (e) {
    const text = checkInErrorText(e);
    if (!text) throw e;
    await ctx.answerCallbackQuery();
    await ctx.reply(text, HTML);
    return;
  }
  await ctx.answerCallbackQuery({ text: 'Checked in!' });
  const lines = [checkInText(await titleOf(deps, a.toiletId), result, user !== null)];
  if (!user) {
    const nudge = await nudgeFor(deps, deviceId);
    if (nudge) lines.push(nudge);
  }
  lines.push(COPY.reportWhich);
  await ctx.reply(lines.join('\n\n'), { ...HTML, reply_markup: statusKeyboard(a.toiletId) });
}

async function onReport(ctx: BotContext, deps: BotDeps, toiletId: string, kind?: StatusKind): Promise<void> {
  if (!kind) {
    await ctx.answerCallbackQuery();
    await ctx.reply(`${COPY.reportWhich} (${await titleOf(deps, toiletId)})`, {
      ...HTML,
      reply_markup: statusKeyboard(toiletId),
    });
    return;
  }
  if (!deps.reportsPerChat.take(String(ctx.chat!.id), sgtDayNumber(new Date()))) {
    await ctx.answerCallbackQuery({ text: 'Daily limit reached' });
    await ctx.reply(COPY.reportLimit, HTML);
    return;
  }
  const user = await linkedUser(ctx, deps);
  const deviceId = chatDeviceId(ctx, deps);
  // Every report in the bot follows a bot answer that sent the person to this toilet.
  const analytics = { ...TELEGRAM, extra: { after_route: true } };
  let view;
  try {
    view = await deps.status.report(toiletId, user ? { userId: user.id } : { deviceId }, kind, undefined, analytics);
  } catch (e) {
    if (e instanceof HttpException && e.getStatus() === HttpStatus.NOT_FOUND) {
      await ctx.answerCallbackQuery();
      await ctx.reply(COPY.toiletGone, HTML);
      return;
    }
    throw e;
  }
  await ctx.answerCallbackQuery({ text: 'Thanks!' });
  const lines = [reportText(kind, await titleOf(deps, toiletId), view.unconfirmed)];
  if (!user) {
    const nudge = await nudgeFor(deps, deviceId);
    if (nudge) lines.push(nudge);
  }
  await ctx.reply(lines.join('\n\n'), HTML);
}

/** "Closest only" on a result: same coordinates, urgent. */
async function onUrgent(ctx: BotContext, deps: BotDeps, lat: number, lng: number): Promise<void> {
  await ctx.answerCallbackQuery();
  const msg = ctx.callbackQuery?.message;
  // Only answers to the person's own location carry check-in buttons; keep that, with the original time.
  const fromOwnLocation =
    msg?.reply_markup?.inline_keyboard.some((row) =>
      row.some((b) => 'callback_data' in b && b.callback_data.startsWith('c:')),
    ) ?? false;
  await replyWithToilets(ctx, deps, {
    origin: { lat, lng },
    urgent: true,
    campaign: 'go',
    checkInMinute: fromOwnLocation && msg ? minuteOf(new Date(msg.date * 1000)) : undefined,
  });
}

export function registerCallbacks(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.on('callback_query:data', async (ctx) => {
    const action = decodeCallback(ctx.callbackQuery.data);
    if (!action) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (action.kind === 'filter') return onFilterToggle(ctx, deps, action.key);
    // Nobody in a group is "here", and group results carry no such buttons.
    if (isGroupChat(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }
    switch (action.kind) {
      case 'urgent':
        return onUrgent(ctx, deps, action.lat, action.lng);
      case 'checkin':
        return onCheckIn(ctx, deps, action);
      case 'report':
        return onReport(ctx, deps, action.toiletId, action.status);
    }
  });
}
