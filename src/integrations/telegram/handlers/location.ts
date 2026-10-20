/** T2 location → top 3, T4 urgent mode, T9 empties; plus the shared "answer with toilets" routine. */
import type { Bot } from 'grammy';
import { inSingapore, type LatLng } from '../../../common/geo.js';
import { baseProps, roundDistance } from '../../../analytics/analytics.js';
import type { RecommendItem } from '../../../routing/recommend.service.js';
import { chatRow, chatDeviceId, editOrReply, HTML, isGroupChat, type BotContext, type BotDeps } from './context.js';
import { COPY, emptyText, errorText, formatCard, formatResults, MAX_RESULTS, minuteOf } from '../format.js';
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
  /** Minute the person's own location was shared (private chats): the card gets "I'm here". */
  checkInMinute?: number;
  /**
   * `single` is the card of the closest toilet (the urgent first answer), `list` the list of up to 3.
   * Default: `single` when urgent, `list` otherwise. Groups always get the list.
   */
  view?: 'list' | 'single';
  /** Count this answer as a new search (`route_started` and the route count). Default: yes when replying, no when editing. */
  track?: boolean;
}

/** The text, and the keyboard when there are results. `top` is the first toilet shown, for analytics. */
export interface ToiletsAnswer {
  text: string;
  keyboard?: InlineKeyboard;
  top?: RecommendItem;
}

/** Ranks toilets around `origin` with the chat's saved filters. Throws when recommend does. */
export async function recommendFor(ctx: BotContext, deps: BotDeps, origin: LatLng, urgent: boolean) {
  const filters = filterStateOf(chatRow(ctx));
  const input = {
    lat: origin.lat,
    lng: origin.lng,
    urgent,
    require: filters.filters,
    areaType: filters.areaType ?? undefined,
    openNow: filters.openNow || undefined,
  };
  let result = await deps.recommend.recommend(input);
  if (!urgent && result.items.length === 0) {
    result = await deps.recommend.recommend({ ...input, radiusM: CALM_WIDE_RADIUS_M });
  }
  return { result, filters };
}

/**
 * Ranks toilets around `origin` with the chat's saved filters and formats the answer: the list, or
 * the closest toilet's card for an urgent first answer. Empty, outside-Singapore and error cases
 * come back as text only.
 */
export async function buildToiletsAnswer(ctx: BotContext, deps: BotDeps, o: AnswerOptions): Promise<ToiletsAnswer> {
  const group = isGroupChat(ctx);
  const map = mapUrl(deps.appBase, o.campaign);
  if (!inSingapore(o.origin)) return { text: COPY.outsideSingapore };

  let found: Awaited<ReturnType<typeof recommendFor>>;
  try {
    found = await recommendFor(ctx, deps, o.origin, o.urgent);
  } catch (e) {
    deps.log.warn(`recommend failed: ${(e as Error).message}`);
    return { text: errorText(map) };
  }
  const { result, filters } = found;
  if (result.items.length === 0) return { text: emptyText({ radiusKm: 3, filters, mapLink: map }) };

  const now = new Date();
  const checkInMinute = group ? undefined : o.checkInMinute;
  const top = result.items[0]!;
  if (!group && (o.view ?? (o.urgent ? 'single' : 'list')) === 'single') {
    const { text, keyboard } = formatCard(top, {
      appBase: deps.appBase,
      campaign: o.campaign,
      urgent: o.urgent,
      origin: o.origin,
      placeName: o.placeName,
      checkInMinute,
      single: true,
      more: Math.min(result.items.length, MAX_RESULTS) - 1,
      now,
    });
    return { text, keyboard, top };
  }
  const { text, keyboard } = formatResults(result, {
    appBase: deps.appBase,
    urgent: o.urgent,
    origin: o.origin,
    placeName: o.placeName,
    stationLink: o.stationLink,
    campaign: o.campaign,
    group,
    checkInMinute,
    filters,
    now,
  });
  return { text, keyboard, top };
}

/**
 * The top result is the one people walk to: emit `route_started` and count its route like the
 * web's "Walk there" (BOT.md §10). Once per search answer, never for Back, a pick or "See more".
 */
async function trackSearch(ctx: BotContext, deps: BotDeps, o: AnswerOptions, top: RecommendItem): Promise<void> {
  const chat = chatRow(ctx);
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

/** Replies with a new message: a search answer, so it is tracked unless `track` is false. */
export async function replyWithToilets(ctx: BotContext, deps: BotDeps, o: AnswerOptions): Promise<void> {
  if (inSingapore(o.origin)) await ctx.replyWithChatAction('typing').catch(() => undefined);
  const { text, keyboard, top } = await buildToiletsAnswer(ctx, deps, o);
  await ctx.reply(text, { ...HTML, reply_markup: keyboard });
  if (top && o.track !== false) await trackSearch(ctx, deps, o, top);
}

/**
 * Edits the tapped message into the answer (Back, "See more", "Nearest only"), or replies when
 * there is nothing to edit. Not tracked unless `track` is set ("Nearest only" is a new search).
 */
export async function editWithToilets(ctx: BotContext, deps: BotDeps, o: AnswerOptions): Promise<void> {
  const { text, keyboard, top } = await buildToiletsAnswer(ctx, deps, o);
  await editOrReply(ctx, text, keyboard);
  if (top && o.track === true) await trackSearch(ctx, deps, o, top);
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
