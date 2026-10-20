/**
 * Inline button taps (BOT.md §6 callback data): `u` nearest only, `p` pick a toilet (its card), `l`
 * back to / more of the list, `c` check in (T6), `r` status report (T7), `f` filter toggle or menu
 * (T8). Everything edits the tapped message in place. Coordinates live only in the callback data
 * Telegram already holds; nothing about them is written to the database.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { Bot } from 'grammy';
import type { User } from '../../../generated/prisma/client.js';
import type { StatusKind } from '../../../generated/prisma/enums.js';
import { sgtDayNumber } from '../../../gamification/sgt.js';
import { POINTS } from '../../../gamification/points.service.js';
import {
  chatRow,
  chatDeviceId,
  editOrReply,
  HTML,
  isGroupChat,
  locationKeyboard,
  type BotContext,
  type BotDeps,
} from './context.js';
import { editWithToilets, recommendFor } from './location.js';
import { onFilterToggle, onFiltersMenu } from './filters.js';
import {
  COPY,
  type CallbackAction,
  checkInExpired,
  checkInText,
  decodeCallback,
  errorText,
  escapeHtml,
  formatCard,
  minuteFromKeyboard,
  nudgeText,
  reportText,
  shouldNudge,
  statusKeyboard,
  toiletTitle,
} from '../format.js';
import { TELEGRAM } from '../identity.js';
import { googleMapsNavigateUrl, mapUrl } from '../links.js';
import { InlineKeyboard } from 'grammy';

/** The linked account behind this chat, if it still exists. */
async function linkedUser(ctx: BotContext, deps: BotDeps): Promise<User | null> {
  const userId = chatRow(ctx).userId;
  if (!userId) return null;
  const user = await deps.prisma.user.findUnique({ where: { id: userId } });
  return user && !user.deletedAt ? user : null;
}

/** Title and position of a toilet, for the edited message; null when it is gone. */
async function toiletInfo(deps: BotDeps, toiletId: string): Promise<{ title: string; lat: number; lng: number } | null> {
  const t = await deps.prisma.toilet.findUnique({
    where: { id: toiletId },
    select: { label: true, level: true, latitude: true, longitude: true, venue: { select: { name: true, type: true } } },
  });
  return t ? { title: toiletTitle(t), lat: t.latitude, lng: t.longitude } : null;
}

const TITLE_FALLBACK = 'this toilet';

/** "<b>Title</b>" heading of an edited card message. */
const heading = (title: string) => `<b>${escapeHtml(title)}</b>`;

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
  const title = (await toiletInfo(deps, a.toiletId))?.title ?? TITLE_FALLBACK;
  const lines = [heading(title), checkInText(title, result, user !== null)];
  if (!user) {
    const nudge = await nudgeFor(deps, deviceId);
    if (nudge) lines.push(nudge);
  }
  lines.push(COPY.reportWhich);
  await editOrReply(ctx, lines.join('\n\n'), statusKeyboard(a.toiletId));
}

async function onReport(ctx: BotContext, deps: BotDeps, toiletId: string, kind?: StatusKind): Promise<void> {
  if (!kind) {
    await ctx.answerCallbackQuery();
    const title = (await toiletInfo(deps, toiletId))?.title ?? TITLE_FALLBACK;
    await editOrReply(ctx, `${heading(title)}\n\n${COPY.reportWhich}`, statusKeyboard(toiletId));
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
  const info = await toiletInfo(deps, toiletId);
  const title = info?.title ?? TITLE_FALLBACK;
  const lines = [heading(title), reportText(kind, title, view.unconfirmed)];
  if (!user) {
    const nudge = await nudgeFor(deps, deviceId);
    if (nudge) lines.push(nudge);
  }
  const navigate = info
    ? new InlineKeyboard().url('🧭 Navigate ↗', googleMapsNavigateUrl({ lat: info.lat, lng: info.lng }))
    : undefined;
  await editOrReply(ctx, lines.join('\n\n'), navigate);
}

/** "Nearest only" on a list: same coordinates, urgent, the message becomes the closest toilet's card. */
async function onUrgent(ctx: BotContext, deps: BotDeps, lat: number, lng: number): Promise<void> {
  await ctx.answerCallbackQuery();
  // Only answers to the person's own location carry check-in buttons: the list's pick buttons hold the minute.
  const checkInMinute = minuteFromKeyboard(ctx.callbackQuery?.message?.reply_markup?.inline_keyboard);
  await editWithToilets(ctx, deps, {
    origin: { lat, lng },
    urgent: true,
    campaign: 'go',
    checkInMinute,
    view: 'single',
    track: true,
  });
}

/** A pick: the list's origin and mode are in the data, so re-rank and open that toilet's card. */
async function onPick(ctx: BotContext, deps: BotDeps, a: Extract<CallbackAction, { kind: 'pick' }>): Promise<void> {
  await ctx.answerCallbackQuery();
  const origin = { lat: a.lat, lng: a.lng };
  let item;
  try {
    item = (await recommendFor(ctx, deps, origin, a.urgent)).result.items.find((i) => i.toilet.id === a.toiletId);
  } catch (e) {
    deps.log.warn(`recommend failed: ${(e as Error).message}`);
    await editOrReply(ctx, errorText(mapUrl(deps.appBase, 'near')));
    return;
  }
  // Gone from the results (filters changed, someone reported it closed): don't guess, ask again.
  if (!item) {
    await editOrReply(ctx, COPY.pickGone);
    return;
  }
  const { text, keyboard } = formatCard(item, {
    appBase: deps.appBase,
    // The data does not say where the origin came from: an own location (minute) reads as "near", a place as "search".
    campaign: a.urgent ? 'go' : a.minute !== undefined ? 'near' : 'search',
    urgent: a.urgent,
    origin,
    checkInMinute: a.minute,
    now: new Date(),
  });
  await editOrReply(ctx, text, keyboard);
}

/** Back to the list, or "See more" from the urgent card. */
async function onList(ctx: BotContext, deps: BotDeps, a: Extract<CallbackAction, { kind: 'list' }>): Promise<void> {
  await ctx.answerCallbackQuery();
  await editWithToilets(ctx, deps, {
    origin: { lat: a.lat, lng: a.lng },
    urgent: a.urgent,
    campaign: a.urgent ? 'go' : a.minute !== undefined ? 'near' : 'search',
    checkInMinute: a.minute,
    view: 'list',
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
    if (action.kind === 'filtersMenu') return onFiltersMenu(ctx);
    // Nobody in a group is "here", and group results carry no such buttons (only Filters).
    if (isGroupChat(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }
    switch (action.kind) {
      case 'urgent':
        return onUrgent(ctx, deps, action.lat, action.lng);
      case 'pick':
        return onPick(ctx, deps, action);
      case 'list':
        return onList(ctx, deps, action);
      case 'checkin':
        return onCheckIn(ctx, deps, action);
      case 'report':
        return onReport(ctx, deps, action.toiletId, action.status);
    }
  });
}
