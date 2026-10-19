/** T5 place-name search: any text that is not a command, and /toilet or /near <place>. */
import type { Bot } from 'grammy';
import { bboxAround, haversineM } from '../../../common/geo.js';
import { areaSlug } from '../../../areas/regions.js';
import {
  chatRow,
  HTML,
  isGroupChat,
  LOCATION_BUTTON,
  locationKeyboard,
  PLACE_BUTTON,
  type BotContext,
  type BotDeps,
} from './context.js';
import { replyWithToilets } from './location.js';
import { COPY, errorText, placeNotFoundText, tidyPlaceName } from '../format.js';
import { isUrgent } from '../chats.service.js';
import { mapUrl, stationUrl, type Campaign } from '../links.js';

const MAX_QUERY = 100;
/** A station hit links its station page when a station venue sits this close to the hit. */
const STATION_MATCH_M = 300;

/** The station page for an "X MRT STATION" search hit, if we have that station. */
async function stationLinkFor(
  deps: BotDeps,
  hit: { name: string; lat: number; lng: number },
  campaign: Campaign,
): Promise<string | undefined> {
  if (!/\b(MRT|LRT) STATION\b/i.test(hit.name)) return undefined;
  const b = bboxAround(hit, STATION_MATCH_M);
  const venues = await deps.prisma.venue.findMany({
    where: {
      type: 'MRT_STATION',
      latitude: { gte: b.minLat, lte: b.maxLat },
      longitude: { gte: b.minLng, lte: b.maxLng },
    },
    select: { name: true, latitude: true, longitude: true },
  });
  const nearest = venues
    .map((v) => ({ v, d: haversineM(hit, { lat: v.latitude, lng: v.longitude }) }))
    .filter((x) => x.d <= STATION_MATCH_M)
    .sort((a, b) => a.d - b.d)[0];
  return nearest ? stationUrl(deps.appBase, areaSlug(nearest.v.name), campaign) : undefined;
}

/** OneMap search → recommend around the top hit. */
export async function searchPlace(ctx: BotContext, deps: BotDeps, raw: string, campaign: Campaign): Promise<void> {
  const query = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY);
  if (!query) return;
  await ctx.replyWithChatAction('typing').catch(() => undefined);
  // OneMapService.search never throws: an outage reads as "not found", which is still honest.
  const hits = await deps.onemap.search(query);
  const hit = hits[0];
  if (!hit) {
    await ctx.reply(placeNotFoundText(query), HTML);
    return;
  }
  const name = tidyPlaceName(hit.name || query);
  let stationLink: string | undefined;
  try {
    stationLink = await stationLinkFor(deps, hit, campaign);
  } catch (e) {
    deps.log.warn(`station lookup failed: ${(e as Error).message}`);
    await ctx.reply(errorText(mapUrl(deps.appBase, campaign)), HTML);
    return;
  }
  // /go then a typed place: still urgent (desktop Telegram cannot share a location).
  const chat = chatRow(ctx);
  const urgent = !isGroupChat(ctx) && isUrgent(chat, new Date());
  if (urgent) await deps.chats.setUrgentUntil(ctx.chat!.id, null);
  await replyWithToilets(ctx, deps, {
    origin: { lat: hit.lat, lng: hit.lng },
    urgent,
    campaign: urgent ? 'go' : campaign,
    placeName: name,
    stationLink,
  });
}

export function registerText(bot: Bot<BotContext>, deps: BotDeps): void {
  // /toilet <place> and its alias /near <place> (§4), in groups and private chats alike.
  bot.command(['toilet', 'near'], async (ctx) => {
    const place = ctx.match.trim();
    if (!place) {
      await ctx.reply(COPY.toiletNeedsPlace, HTML);
      return;
    }
    await searchPlace(ctx, deps, place, 'near');
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (isGroupChat(ctx)) {
      // Privacy mode: in a group the bot only sees commands and replies to its own messages.
      // Unknown commands may be for another bot, so stay quiet; a reply to the bot is a search.
      if (text.startsWith('/')) return;
      if (ctx.message.reply_to_message?.from?.id === ctx.me.id) await searchPlace(ctx, deps, text, 'search');
      return;
    }
    if (text.startsWith('/')) {
      await ctx.reply(COPY.unknownCommand, HTML);
      return;
    }
    if (text === PLACE_BUTTON) {
      await ctx.reply(COPY.typePlace, HTML);
      return;
    }
    if (text === LOCATION_BUTTON) {
      // Desktop Telegram shows the button but cannot share a location.
      await ctx.reply(`${COPY.askLocation}\n${COPY.typePlace}`, { ...HTML, reply_markup: locationKeyboard() });
      return;
    }
    await searchPlace(ctx, deps, text, 'search');
  });
}
