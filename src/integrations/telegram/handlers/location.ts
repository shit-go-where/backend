/** T2 location → top 3, T4 urgent mode, T9 empties; plus the shared "answer with toilets" routine. */
import type { Bot } from 'grammy';
import { inSingapore, type LatLng } from '../../../common/geo.js';
import { baseProps, roundDistance } from '../../../analytics/analytics.js';
import { chatRow, chatDeviceId, HTML, isGroupChat, type BotContext, type BotDeps } from './context.js';
import { COPY, emptyText, errorText, formatResults, minuteOf } from '../format.js';
import { filterStateOf, isUrgent } from '../chats.service.js';
import { botDeepLink, mapUrl, type Campaign } from '../links.js';
import { TELEGRAM, botDistinctId } from '../identity.js';
import { InlineKeyboard } from 'grammy';

/** Calm search widens to this when the app's default 1.5 km finds nothing (T9: "nothing within 3 km"). */
const CALM_WIDE_RADIUS_M = 3000;

export interface AnswerOptions {
  origin: LatLng;
  urgent: boolean;
  campaign: Campaign;
  placeName?: string;
  stationLink?: string;
  /** Minute the person's own location was shared (private chats): adds "I'm here" buttons. */
  checkInMinute?: number;
}

/**
 * Ranks toilets around `origin` with the chat's saved filters and replies with the top 3 and their
 * buttons. Emits `route_started` for the top result and counts its route (BOT.md §10).
 */
export async function replyWithToilets(ctx: BotContext, deps: BotDeps, o: AnswerOptions): Promise<void> {
  const chat = chatRow(ctx);
  const group = isGroupChat(ctx);
  const map = mapUrl(deps.appBase, o.campaign);
  if (!inSingapore(o.origin)) {
    await ctx.reply(COPY.outsideSingapore, HTML);
    return;
  }
  await ctx.replyWithChatAction('typing').catch(() => undefined);

  const filters = filterStateOf(chat);
  const input = {
    lat: o.origin.lat,
    lng: o.origin.lng,
    urgent: o.urgent,
    require: filters.filters,
    areaType: filters.areaType ?? undefined,
    openNow: filters.openNow || undefined,
  };
  let result: Awaited<ReturnType<BotDeps['recommend']['recommend']>>;
  try {
    result = await deps.recommend.recommend(input);
    if (!o.urgent && result.items.length === 0) {
      result = await deps.recommend.recommend({ ...input, radiusM: CALM_WIDE_RADIUS_M });
    }
  } catch (e) {
    deps.log.warn(`recommend failed: ${(e as Error).message}`);
    await ctx.reply(errorText(map), HTML);
    return;
  }

  if (result.items.length === 0) {
    await ctx.reply(emptyText({ radiusKm: 3, filters, mapLink: map }), HTML);
    return;
  }

  const { text, keyboard } = formatResults(result, {
    appBase: deps.appBase,
    urgent: o.urgent,
    origin: o.origin,
    placeName: o.placeName,
    stationLink: o.stationLink,
    campaign: o.campaign,
    group,
    checkInMinute: group ? undefined : o.checkInMinute,
    filters,
    now: new Date(),
  });
  await ctx.reply(text, { ...HTML, reply_markup: keyboard });

  // The top result is the one people walk to: count it like the web's "Walk there" (BOT.md §10).
  const top = result.items[0]!;
  const deviceId = chatDeviceId(ctx, deps);
  deps.analytics.track('route_started', botDistinctId(deviceId, chat.userId), {
    ...baseProps({ userId: chat.userId }, TELEGRAM),
    toilet_id: top.toilet.id,
    toilet_tier: top.toilet.tier,
    urgent: o.urgent,
    distance_m: roundDistance(top.walkDistanceM),
  });
  if (top.toilet.status === 'ACTIVE') {
    await deps.routeCounts
      .record(top.toilet.id)
      .catch((e: Error) => deps.log.warn(`route count failed: ${e.message}`));
  }
}

export function registerLocation(bot: Bot<BotContext>, deps: BotDeps): void {
  bot.on('message:location', async (ctx) => {
    // A location in a group shows everyone where you are: move it to a private chat (§4).
    if (isGroupChat(ctx)) {
      const kb = deps.botUsername
        ? new InlineKeyboard().url('Find near me', botDeepLink(deps.botUsername, 'near'))
        : undefined;
      await ctx.reply(COPY.locationInGroup, { ...HTML, reply_markup: kb });
      return;
    }
    const chat = chatRow(ctx);
    const now = new Date();
    const urgent = isUrgent(chat, now);
    if (urgent) await deps.chats.setUrgentUntil(ctx.chat.id, null);
    const { latitude, longitude } = ctx.message.location;
    // A picked venue or a forwarded pin is not where the person stands: no check-in buttons.
    const own = !ctx.message.venue && !ctx.message.forward_origin;
    await replyWithToilets(ctx, deps, {
      origin: { lat: latitude, lng: longitude },
      urgent,
      campaign: urgent ? 'go' : 'near',
      placeName: ctx.message.venue?.title,
      // The message date is when the location was shared; check-ins ride on it for 10 minutes.
      checkInMinute: own ? minuteOf(new Date(ctx.message.date * 1000)) : undefined,
    });
  });
}
