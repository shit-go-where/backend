/**
 * Links the bot sends (BOT.md §10 "Source tags"). Pure: the app origin and bot username are
 * passed in, so this file never reads env and is unit-tested as is.
 *
 * Every app link carries utm_source=telegram, utm_medium=bot and the command as utm_campaign.
 * No `?src=` in the bot, and never any coordinates in a URL.
 */

/** utm_campaign values the bot uses (BOT.md §10): the command or flow that produced the link. */
export type Campaign = 'start' | 'go' | 'near' | 'checkin' | 'search' | 'help' | 'privacy' | 'filters' | 'flag-reply';

export const UTM_SOURCE = 'telegram';
export const UTM_MEDIUM = 'bot';

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** `${base}${path}?utm_source=telegram&utm_medium=bot&utm_campaign=<campaign>` (+ #hash). */
export function appUrl(base: string, path: string, campaign: Campaign, hash?: string): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, `${trimSlash(base)}/`);
  url.searchParams.set('utm_source', UTM_SOURCE);
  url.searchParams.set('utm_medium', UTM_MEDIUM);
  url.searchParams.set('utm_campaign', campaign);
  if (hash) url.hash = hash;
  return url.toString();
}

export const toiletUrl = (base: string, toiletId: string, campaign: Campaign) =>
  appUrl(base, `/toilets/${encodeURIComponent(toiletId)}`, campaign);

export const stationUrl = (base: string, slug: string, campaign: Campaign) =>
  appUrl(base, `/stations/${encodeURIComponent(slug)}`, campaign);

export const mapUrl = (base: string, campaign: Campaign) => appUrl(base, '/', campaign);

export const privacyUrl = (base: string) => appUrl(base, '/privacy', 'privacy', 'telegram');

/**
 * Google Maps walking directions with no origin, so Maps starts from the phone's live position and
 * `dir_action=navigate` goes straight into turn-by-turn (same as the app, PLAN.md §12 A).
 */
export function googleMapsNavigateUrl(to: { lat: number; lng: number }): string {
  const p = new URLSearchParams({
    api: '1',
    destination: `${to.lat},${to.lng}`,
    travelmode: 'walking',
    dir_action: 'navigate',
  });
  return `https://www.google.com/maps/dir/?${p.toString()}`;
}

/** Telegram start payloads allow A-Z, a-z, 0-9, _ and -, up to 64 characters. */
const START_PAYLOAD_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `https://t.me/<bot>` or `https://t.me/<bot>?start=<payload>` (opens a private chat with the bot). */
export function botDeepLink(username: string, payload?: string): string {
  const name = username.replace(/^@/, '');
  if (payload === undefined) return `https://t.me/${name}`;
  if (!START_PAYLOAD_RE.test(payload)) throw new Error('Invalid start payload');
  return `https://t.me/${name}?start=${payload}`;
}
