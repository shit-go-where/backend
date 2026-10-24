/**
 * Pure formatting for the Telegram bot (BOT.md §6): recommend results → HTML text + inline
 * keyboards, callback data (64-byte limit), filter toggles and every piece of copy. No network,
 * no env, no database, so it is unit-tested without Telegram.
 *
 * Voice (PRODUCT.md): Singlish is fine in onboarding, help, empties and celebrations. Anything a
 * person needs mid-urgency (distances, walk minutes, features, status, toilet names) is plain English.
 * Everything user-derived is HTML-escaped (parse_mode HTML).
 */
import { InlineKeyboard } from 'grammy';
import type { AreaType, Feature, StatusKind, ToiletTier } from '../../generated/prisma/enums.js';
import type { RecommendItem } from '../../routing/recommend.service.js';
import type { ToiletSex } from '../../toilets/sex.js';
import { googleMapsNavigateUrl, toiletUrl, type Campaign } from './links.js';

// ───────────────────────────── basics ─────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const link = (href: string, text: string) => `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10 || Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

export const walkMinutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

/** "Tampines" the MRT station reads as "Tampines MRT" once it is out of its own heading. */
export function placeName(v: { name: string; type: string }): string {
  return v.type === 'MRT_STATION' && !/\b(MRT|LRT)\b/i.test(v.name) ? `${v.name} MRT` : v.name;
}

const KEEP_CAPS = new Set(['MRT', 'LRT', 'HDB', 'NTUC', 'CC', 'SAFRA', 'YMCA', 'NUS', 'NTU', 'SMU', 'SUTD', 'ITE', 'JTC', 'CPF', 'ICA', 'SGH', 'KK', 'BLK', 'ST']);

/** OneMap's ALL-CAPS names in title case ("BISHAN MRT STATION (NS17)" → "Bishan MRT Station (NS17)"). */
export function tidyPlaceName(s: string): string {
  if (/[a-z]/.test(s)) return s;
  return s.toLowerCase().replace(/[a-z0-9'’]+/g, (w) => {
    const up = w.toUpperCase();
    if (KEEP_CAPS.has(up) || /\d/.test(w)) return up;
    return w[0]!.toUpperCase() + w.slice(1);
  });
}

// ───────────────────────────── labels ─────────────────────────────

export const STATUS_LABELS: Record<StatusKind, string> = {
  ALL_GOOD: 'All good',
  NO_PAPER: 'No paper',
  NO_SOAP: 'No soap',
  LONG_QUEUE: 'Long queue',
  BEING_CLEANED: 'Being cleaned',
  BROKEN: 'Something broken',
  CLOSED_NOW: 'Closed now',
};

/** One icon per status for the picker buttons. The labels above stay plain: they are used in prose. */
export const STATUS_ICONS: Record<StatusKind, string> = {
  ALL_GOOD: '👍',
  NO_PAPER: '🧻',
  NO_SOAP: '🧼',
  LONG_QUEUE: '⏳',
  BEING_CLEANED: '🧹',
  BROKEN: '🔧',
  CLOSED_NOW: '🚫',
};

/** Report buttons, in the order the web shows them. */
export const REPORT_KINDS: StatusKind[] = [
  'ALL_GOOD',
  'NO_PAPER',
  'NO_SOAP',
  'LONG_QUEUE',
  'BEING_CLEANED',
  'BROKEN',
  'CLOSED_NOW',
];

const TIER_LABELS: Record<ToiletTier, string> = { VERIFIED: 'Verified', COMMUNITY: 'Community', IMPORTED: 'Imported' };

const FEATURE_LABELS: Partial<Record<Feature, string>> = {
  ACCESSIBLE: 'Accessible',
  BIDET: 'Bidet',
  FREE: 'Free',
  BABY_CHANGE: 'Baby change',
  NURSING_ROOM: 'Nursing room',
  SITTING: 'Sitting',
  SQUAT: 'Squat',
  TOILET_PAPER: 'Toilet paper',
  HAND_SOAP: 'Hand soap',
  SHOWER: 'Shower',
  UNISEX: 'Unisex',
  PERIOD_PRODUCTS: 'Pads or tampons',
};
/** Most decision-relevant first; a result shows the first few it has. */
const FEATURE_ORDER = Object.keys(FEATURE_LABELS) as Feature[];
const MAX_FEATURES = 4;

// ───────────────────────────── filters (T8) ─────────────────────────────

export type FilterKey = 'ACCESSIBLE' | 'BIDET' | 'FREE' | 'SITTING' | 'BABY_CHANGE' | 'NURSING_ROOM' | 'UNPAID' | 'OPEN';

export const FILTER_OPTIONS: { key: FilterKey; label: string }[] = [
  { key: 'ACCESSIBLE', label: 'Accessible' },
  { key: 'BIDET', label: 'Bidet' },
  { key: 'FREE', label: 'Free' },
  { key: 'SITTING', label: 'Sitting toilet' },
  { key: 'BABY_CHANGE', label: 'Baby change' },
  { key: 'NURSING_ROOM', label: 'Nursing room' },
  { key: 'UNPAID', label: 'Outside paid area' },
  { key: 'OPEN', label: 'Open now' },
];

export interface FilterState {
  filters: Feature[];
  areaType: AreaType | null;
  openNow: boolean;
}

export function isFilterOn(s: FilterState, key: FilterKey): boolean {
  if (key === 'UNPAID') return s.areaType === 'UNPAID_AREA';
  if (key === 'OPEN') return s.openNow;
  return s.filters.includes(key as Feature);
}

export function toggleFilter(s: FilterState, key: FilterKey): FilterState {
  if (key === 'UNPAID') return { ...s, areaType: s.areaType === 'UNPAID_AREA' ? null : 'UNPAID_AREA' };
  if (key === 'OPEN') return { ...s, openNow: !s.openNow };
  const f = key as Feature;
  return { ...s, filters: s.filters.includes(f) ? s.filters.filter((x) => x !== f) : [...s.filters, f] };
}

/** "accessible, bidet" in the fixed option order, or null when nothing is set. */
export function filtersSummary(s: FilterState): string | null {
  const on = FILTER_OPTIONS.filter((o) => isFilterOn(s, o.key)).map((o) => o.label.toLowerCase());
  return on.length ? on.join(', ') : null;
}

export function filtersMessage(s: FilterState): { text: string; keyboard: InlineKeyboard } {
  const summary = filtersSummary(s);
  const text =
    '<b>Filters</b>\nTap to switch. They apply to every search in this chat until you change them.\n\n' +
    (summary ? `On: ${escapeHtml(summary)}` : 'None on: you get every toilet.');
  const kb = new InlineKeyboard();
  FILTER_OPTIONS.forEach((o, i) => {
    kb.text(`${isFilterOn(s, o.key) ? '✅' : '⬜️'} ${o.label}`, encodeCallback({ kind: 'filter', key: o.key })!);
    if (i % 2 === 1) kb.row();
  });
  return { text, keyboard: kb };
}

// ───────────────────────────── callback data (BOT.md §6) ─────────────────────────────

/**
 * Wire formats (all within 64 bytes; coordinates at 4 dp; `<m>` is `u` urgent or `c` calm; `minute`
 * is base36 and present only for the person's own fresh location in a private chat):
 *   u:<lat>,<lng>                           Nearest only
 *   p:<m>,<toiletId>,<lat>,<lng>[,<minute>] pick: the toilet's card
 *   l:<m>,<lat>,<lng>[,<minute>]            (re)render the list: Back, See more
 *   c:<toiletId>,<lat>,<lng>,<minute>       I'm here
 *   r:<toiletId>[,<status>]                 Report / report with a status
 *   f:<key> | f:*                           toggle a filter / open the filters message
 */
export const CALLBACK_MAX_BYTES = 64;
/** A check-in button older than this asks for a fresh location. */
export const CHECKIN_TTL_MS = 10 * 60_000;

export type CallbackAction =
  /** "Nearest only": re-run urgent at these coordinates. */
  | { kind: 'urgent'; lat: number; lng: number }
  /**
   * Pick one toilet of a list: show its card. `urgent` is the list's mode (`u` or `c` on the wire),
   * `lat`/`lng` the search origin, `minute` only for the person's own fresh location (private chat).
   */
  | { kind: 'pick'; urgent: boolean; toiletId: string; lat: number; lng: number; minute?: number }
  /** (Re)render the list at this origin: "Back to list" and "See more" from an urgent card. */
  | { kind: 'list'; urgent: boolean; lat: number; lng: number; minute?: number }
  /** "Filters": send the /filters message (the answer it was tapped on stays). */
  | { kind: 'filtersMenu' }
  /** "I'm here": check in with the coordinates the person shared, at `minute` (minutes since epoch). */
  | { kind: 'checkin'; toiletId: string; lat: number; lng: number; minute: number }
  /** "Report": without `status`, show the status buttons; with it, file the report. */
  | { kind: 'report'; toiletId: string; status?: StatusKind }
  | { kind: 'filter'; key: FilterKey };

const coord = (n: number) => n.toFixed(4);
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const NUM_RE = /^-?\d{1,3}\.\d{1,6}$/;
const MINUTE_RE = /^[0-9a-z]{1,10}$/;

export const minuteOf = (d: Date) => Math.floor(d.getTime() / 60_000);

const minutePart = (minute: number | undefined) => (minute === undefined ? '' : `,${minute.toString(36)}`);

/** The optional trailing minute (base36) of a `p:`/`l:` payload; `null` when present but malformed. */
function parseMinute(part: string | undefined): number | undefined | null {
  if (part === undefined) return undefined;
  if (!MINUTE_RE.test(part)) return null;
  const minute = parseInt(part, 36);
  return Number.isFinite(minute) ? minute : null;
}

/** Encoded data, or null when it would not fit Telegram's 64 bytes (or has bad parts). */
export function encodeCallback(a: CallbackAction): string | null {
  let s: string;
  switch (a.kind) {
    case 'urgent':
      s = `u:${coord(a.lat)},${coord(a.lng)}`;
      break;
    case 'checkin':
      if (!ID_RE.test(a.toiletId)) return null;
      s = `c:${a.toiletId},${coord(a.lat)},${coord(a.lng)},${a.minute.toString(36)}`;
      break;
    case 'pick':
      if (!ID_RE.test(a.toiletId)) return null;
      s = `p:${a.urgent ? 'u' : 'c'},${a.toiletId},${coord(a.lat)},${coord(a.lng)}${minutePart(a.minute)}`;
      break;
    case 'list':
      s = `l:${a.urgent ? 'u' : 'c'},${coord(a.lat)},${coord(a.lng)}${minutePart(a.minute)}`;
      break;
    case 'report':
      if (!ID_RE.test(a.toiletId)) return null;
      s = a.status ? `r:${a.toiletId},${a.status}` : `r:${a.toiletId}`;
      break;
    case 'filter':
      s = `f:${a.key}`;
      break;
    case 'filtersMenu':
      s = 'f:*';
      break;
  }
  return Buffer.byteLength(s, 'utf8') <= CALLBACK_MAX_BYTES ? s : null;
}

function latLng(latS: string | undefined, lngS: string | undefined): { lat: number; lng: number } | null {
  if (!latS || !lngS || !NUM_RE.test(latS) || !NUM_RE.test(lngS)) return null;
  const lat = Number(latS);
  const lng = Number(lngS);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Parses callback data; null for anything malformed or unknown (never trusted beyond this). */
export function decodeCallback(data: string | undefined): CallbackAction | null {
  if (!data || data.length > CALLBACK_MAX_BYTES || data[1] !== ':') return null;
  const parts = data.slice(2).split(',');
  switch (data[0]) {
    case 'u': {
      if (parts.length !== 2) return null;
      const p = latLng(parts[0], parts[1]);
      return p ? { kind: 'urgent', ...p } : null;
    }
    case 'c': {
      if (parts.length !== 4 || !ID_RE.test(parts[0]!) || !MINUTE_RE.test(parts[3]!)) return null;
      const p = latLng(parts[1], parts[2]);
      const minute = parseInt(parts[3]!, 36);
      return p && Number.isFinite(minute) ? { kind: 'checkin', toiletId: parts[0]!, ...p, minute } : null;
    }
    case 'p': {
      if ((parts.length !== 4 && parts.length !== 5) || (parts[0] !== 'u' && parts[0] !== 'c') || !ID_RE.test(parts[1]!)) {
        return null;
      }
      const p = latLng(parts[2], parts[3]);
      const minute = parseMinute(parts[4]);
      if (!p || minute === null) return null;
      return { kind: 'pick', urgent: parts[0] === 'u', toiletId: parts[1]!, ...p, ...(minute !== undefined && { minute }) };
    }
    case 'l': {
      if ((parts.length !== 3 && parts.length !== 4) || (parts[0] !== 'u' && parts[0] !== 'c')) return null;
      const p = latLng(parts[1], parts[2]);
      const minute = parseMinute(parts[3]);
      if (!p || minute === null) return null;
      return { kind: 'list', urgent: parts[0] === 'u', ...p, ...(minute !== undefined && { minute }) };
    }
    case 'r': {
      if (parts.length > 2 || !ID_RE.test(parts[0]!)) return null;
      if (parts.length === 1) return { kind: 'report', toiletId: parts[0]! };
      const status = parts[1] as StatusKind;
      return REPORT_KINDS.includes(status) ? { kind: 'report', toiletId: parts[0]!, status } : null;
    }
    case 'f': {
      if (parts.length === 1 && parts[0] === '*') return { kind: 'filtersMenu' };
      const key = parts[0] as FilterKey;
      return parts.length === 1 && FILTER_OPTIONS.some((o) => o.key === key) ? { kind: 'filter', key } : null;
    }
    default:
      return null;
  }
}

/**
 * The minute a keyboard's own-location buttons carry (`p:`/`l:` payloads), or undefined when none
 * does: the origin was a searched place, not where the person stands.
 */
export function minuteFromKeyboard(
  inlineKeyboard: ReadonlyArray<ReadonlyArray<{ text: string; callback_data?: string }>> | undefined,
): number | undefined {
  for (const row of inlineKeyboard ?? []) {
    for (const b of row) {
      const a = decodeCallback(b.callback_data);
      if ((a?.kind === 'pick' || a?.kind === 'list') && a.minute !== undefined) return a.minute;
    }
  }
  return undefined;
}

/** A check-in button is good for 10 minutes after the location it carries was shared. */
export function checkInExpired(minute: number, now: Date): boolean {
  return now.getTime() - minute * 60_000 > CHECKIN_TTL_MS;
}

// ───────────────────────────── results (T2, T3) ─────────────────────────────

export interface ResultsInput {
  items: RecommendItem[];
  searchedRadiusM: number;
  skippedVenues: { name: string; toiletStatus: string; note: string | null; distanceM: number }[];
}

export interface ResultsOptions {
  appBase: string;
  urgent: boolean;
  /** Where the coordinates came from: the person's shared location, or a searched place. */
  origin: { lat: number; lng: number };
  /** Set for place searches: "Toilets near <placeName>". */
  placeName?: string;
  /** Station page for a station hit (GROWTH 1.2). */
  stationLink?: string;
  campaign: Campaign;
  /** Groups get a Navigate link per toilet and Filters only (nobody in a group is "here"). */
  group: boolean;
  /**
   * Minute the person's location was shared; the pick buttons carry it on to the card's "I'm here".
   * Only for the person's own location in a private chat: a searched place is not where they are.
   */
  checkInMinute?: number;
  filters: FilterState;
  now: Date;
}

const DAY_MS = 86_400_000;

/** "checked 3 days ago", at day resolution (a chat keeps a message for days). */
export function lastCheckedText(iso: string | null, now: Date): string {
  if (!iso) return 'never checked in person';
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS);
  if (!Number.isFinite(days)) return 'never checked in person';
  if (days < 1) return 'checked today';
  if (days < 2) return 'checked yesterday';
  if (days < 14) return `checked ${days} days ago`;
  if (days < 60) return `checked ${plural(Math.floor(days / 7), 'week')} ago`;
  if (days < 730) return `checked ${plural(Math.floor(days / 30), 'month')} ago`;
  return `checked ${plural(Math.floor(days / 365), 'year')} ago`;
}

/** The share card's verdict word (frontend lib/og.tsx), framing only: the number is always shown. */
export function verdictWord(score: number | null): string | null {
  if (score === null || Number.isNaN(score)) return null;
  if (score >= 8) return 'Shiok!';
  if (score >= 6) return 'Can lah';
  return 'Aiyo';
}

const scoreNumber = (n: number) => n.toFixed(1).replace(/\.0$/, '');

/** Who a toilet is for, as the title says it. */
export const SEX_LABELS: Record<ToiletSex, string> = { MALE: "Men's", FEMALE: "Women's", UNISEX: 'Unisex' };
/** A label that already says it ("Women's, NEL side", "Accessible / unisex") gets no second mention. */
const SEX_IN_LABEL: Record<ToiletSex, RegExp> = {
  MALE: /\bmen'?s\b|\bmale\b|\bgents?\b/i,
  FEMALE: /\bwomen'?s\b|\bfemale\b|\bladies\b/i,
  UNISEX: /\bunisex\b/i,
};

/** "Test Mall · L1 near lifts · Women's": venue, then the toilet's label or level, then who it is for. */
export function toiletTitle(t: {
  label: string | null;
  level: string | null;
  venue: { name: string; type: string };
  sex?: ToiletSex | null;
}): string {
  const parts = [placeName(t.venue)];
  if (t.label) parts.push(t.label);
  if (t.level && !(t.label ?? '').toLowerCase().includes(t.level.toLowerCase())) parts.push(t.level);
  if (t.sex && !SEX_IN_LABEL[t.sex].test(t.label ?? '')) parts.push(SEX_LABELS[t.sex]);
  return parts.join(' · ');
}

function areaText(a: AreaType): string | null {
  if (a === 'PAID_AREA') return 'inside the fare gates';
  if (a === 'UNPAID_AREA') return 'outside the fare gates';
  return null;
}

/** Everything under a toilet's title: walk, tier, score, live status, features. Shared by the list and the card. */
function itemLines(item: RecommendItem, now: Date): string[] {
  const t = item.toilet;
  const lines: string[] = [];
  const walk = [`${walkMinutes(item.walkSeconds)} min walk`, formatDistance(item.walkDistanceM)];
  const area = areaText(t.areaType);
  if (area) walk.push(area);
  lines.push(walk.join(' · '));
  lines.push(
    item.unconfirmed
      ? 'Unconfirmed · new, nobody has confirmed it yet'
      : `${TIER_LABELS[t.tier]} · ${lastCheckedText(t.lastVerifiedAt, now)}`,
  );
  if (t.scoreCleanliness !== null) {
    const verdict = verdictWord(t.scoreCleanliness);
    const survey = t.surveyTotal !== null ? ` · survey ${scoreNumber(t.surveyTotal)}/50` : '';
    lines.push(`Clean ${scoreNumber(t.scoreCleanliness)}/10${verdict ? ` (${verdict})` : ''}${survey}`);
  }
  if (t.activeStatus.length) {
    const live = t.activeStatus.map((s) => `${STATUS_LABELS[s.kind]}, ${plural(s.count, 'report')}`).join(' · ');
    const bad = t.activeStatus.some((s) => s.kind !== 'ALL_GOOD');
    lines.push(`${bad ? '⚠️' : '✅'} Now: ${live}`);
  }
  // "Unisex" is already in the title once the toilet's sex is known.
  const features = FEATURE_ORDER.filter((f) => t.features.includes(f) && !(f === 'UNISEX' && t.sex)).slice(0, MAX_FEATURES);
  if (features.length) lines.push(features.map((f) => FEATURE_LABELS[f]).join(', '));
  return lines;
}

/** The escaped title, as a link to the details page when there is one. */
const titleMarkup = (item: RecommendItem, detailsUrl?: string) =>
  detailsUrl ? link(detailsUrl, toiletTitle(item.toilet)) : escapeHtml(toiletTitle(item.toilet));

/** One numbered entry, several lines. With `detailsUrl` the title links to the toilet's page. */
export function formatItem(item: RecommendItem, n: number, now: Date, detailsUrl?: string): string {
  return [`<b>${n}. ${titleMarkup(item, detailsUrl)}</b>`, ...itemLines(item, now)].join('\n');
}

/** Button labels stay short enough to read on a phone. */
const SHORT_TITLE_MAX = 28;

function shortTitle(item: RecommendItem): string {
  const title = toiletTitle(item.toilet);
  return title.length > SHORT_TITLE_MAX ? `${title.slice(0, SHORT_TITLE_MAX - 1).trimEnd()}…` : title;
}

/** "1. Test Mall · L1 near lifts · 3 min": the title cut to 28 characters (with "…"), then the walk. */
export function pickLabel(item: RecommendItem, n: number): string {
  return `${n}. ${shortTitle(item)} · ${walkMinutes(item.walkSeconds)} min`;
}

function header(o: ResultsOptions, count: number): string {
  if (o.placeName) return `🚽 <b>Toilets near ${escapeHtml(o.placeName)}</b>`;
  if (o.urgent) return count === 1 ? '🚨 <b>Closest to you</b>' : '🚨 <b>Closest to you</b>, by walking time';
  return `🚽 <b>${count === 1 ? 'Best one' : `Top ${count}`} near you</b>`;
}

export const MAX_RESULTS = 3;

/**
 * The list (BOT.md §6): up to 3 toilets with title links in the text and one pick button each.
 * Groups get a Navigate link per toilet instead (nobody in a group is "here", so no card).
 */
export function formatResults(r: ResultsInput, o: ResultsOptions): { text: string; keyboard: InlineKeyboard } {
  const items = r.items.slice(0, MAX_RESULTS);
  const blocks = [
    header(o, items.length),
    ...items.map((it, i) => formatItem(it, i + 1, o.now, toiletUrl(o.appBase, it.toilet.id, o.campaign))),
  ];

  const skipped = r.skippedVenues.slice(0, 2);
  if (skipped.length) {
    const list = skipped
      .map((v) => `${escapeHtml(v.name)}${v.note ? ` (${escapeHtml(v.note)})` : ''}`)
      .join('; ');
    blocks.push(`Nearby but no toilet: ${list}`);
  }
  const foot: string[] = [];
  const summary = filtersSummary(o.filters);
  if (summary) foot.push(`Filters: ${escapeHtml(summary)} (change with /filters)`);
  if (o.stationLink) foot.push(link(o.stationLink, 'Station page'));
  if (foot.length) blocks.push(foot.join('\n'));

  const kb = new InlineKeyboard();
  items.forEach((it, i) => {
    const n = i + 1;
    const t = it.toilet;
    const navigate = googleMapsNavigateUrl({ lat: t.lat, lng: t.lng });
    if (o.group) {
      kb.url(`🧭 ${n}. ${shortTitle(it)} ↗`, navigate).row();
      return;
    }
    const pick = encodeCallback({
      kind: 'pick',
      urgent: o.urgent,
      toiletId: t.id,
      lat: o.origin.lat,
      lng: o.origin.lng,
      minute: o.checkInMinute,
    });
    // An id too long for the callback limit must not drop its row: send them to Maps instead.
    if (pick) kb.text(pickLabel(it, n), pick);
    else kb.url(`🧭 ${n}. Navigate ↗`, navigate);
    kb.row();
  });
  if (!o.group && !o.urgent) {
    const u = encodeCallback({ kind: 'urgent', lat: o.origin.lat, lng: o.origin.lng });
    if (u) kb.text('🚨 Nearest only', u);
  }
  kb.text('🎛 Filters', encodeCallback({ kind: 'filtersMenu' })!);
  return { text: blocks.join('\n\n'), keyboard: kb };
}

export interface CardOptions {
  appBase: string;
  campaign: Campaign;
  /** The list's mode: carried by Back and See more so the list comes back the way it was. */
  urgent: boolean;
  /** Search origin: carried by Back, See more and I'm here. */
  origin: { lat: number; lng: number };
  /** Set for place searches: "Near <placeName>" above the title. */
  placeName?: string;
  /** Minute the person's own location was shared: adds "I'm here". Never for a searched place. */
  checkInMinute?: number;
  /** The urgent first answer: no Back (there is no list yet), and "See N more" when `more` > 0. */
  single?: boolean;
  /** How many other results the list has. */
  more?: number;
  now: Date;
}

/** One toilet in full (private chats only): `formatItem` without the number, plus Navigate / Details / I'm here / Report. */
export function formatCard(item: RecommendItem, o: CardOptions): { text: string; keyboard: InlineKeyboard } {
  const t = item.toilet;
  const details = toiletUrl(o.appBase, t.id, o.campaign);
  const lines: string[] = [];
  if (o.single && o.urgent) {
    lines.push(o.placeName ? `🚨 <b>Closest near ${escapeHtml(o.placeName)}</b>` : '🚨 <b>Closest to you</b>');
  } else if (o.placeName) {
    lines.push(`🚽 Near ${escapeHtml(o.placeName)}`);
  }
  lines.push(`<b>${titleMarkup(item, details)}</b>`, ...itemLines(item, o.now));

  const kb = new InlineKeyboard()
    .url('🧭 Navigate ↗', googleMapsNavigateUrl({ lat: t.lat, lng: t.lng }))
    .url('ℹ️ Details ↗', details)
    .row();
  const checkIn =
    o.checkInMinute !== undefined
      ? encodeCallback({ kind: 'checkin', toiletId: t.id, lat: o.origin.lat, lng: o.origin.lng, minute: o.checkInMinute })
      : null;
  const report = encodeCallback({ kind: 'report', toiletId: t.id });
  if (checkIn) kb.text("✅ I'm here", checkIn);
  if (report) kb.text('⚠️ Report', report);
  const list = encodeCallback({
    kind: 'list',
    urgent: o.urgent,
    lat: o.origin.lat,
    lng: o.origin.lng,
    minute: o.checkInMinute,
  });
  // Back to the list, or (urgent first answer: no list yet) a way to see the others.
  const tail = o.single ? (o.more && o.more > 0 ? `📋 See ${o.more} more` : null) : '◀ Back to list';
  if (list && tail) kb.row().text(tail, list);
  return { text: lines.join('\n'), keyboard: kb };
}

/** Status buttons for a toilet (T7), two per row. */
export function statusKeyboard(toiletId: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  REPORT_KINDS.forEach((kind, i) => {
    const data = encodeCallback({ kind: 'report', toiletId, status: kind });
    if (data) kb.text(`${STATUS_ICONS[kind]} ${STATUS_LABELS[kind]}`, data);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

// ───────────────────────────── copy ─────────────────────────────

export function startText(): string {
  return [
    '<b>Shit Go Where?</b> Need to go? I find you the nearest clean toilet in Singapore, lah.',
    '📍 <b>Send my location</b>: the top 3 toilets near you, with walk time, cleanliness and live reports.',
    '🚨 Really cannot tahan? Send /go first and I show only the closest.',
    '🔎 No location? Just type a place, like <i>Bishan MRT</i> or a postal code.',
    'No sign-up needed. /help for the rest.',
  ].join('\n\n');
}

export function helpText(mapLink: string): string {
  return [
    '<b>How to use me</b>',
    [
      '📍 Send your location: top 3 toilets near you',
      '🔎 Type a place (a mall, MRT station or postal code): toilets near there',
      '/go: urgent mode, your next location gets the closest toilets only',
      '/filters: always want accessible, bidet, free and so on? Set it once here',
      '/toilet &lt;place&gt;: toilets near a place (works in groups too)',
      '/privacy: what I keep about this chat',
      '/unlink: disconnect your Shit Go Where account',
      '/stop: forget this chat',
    ].join('\n'),
    'At the toilet? Send your location and tap <b>I\'m here</b> to check in (you need to be within 150 m). Tap <b>Report</b> to say there is no paper, a long queue and so on.',
    `Full map: ${link(mapLink, 'Shit Go Where')}`,
  ].join('\n\n');
}

export function groupHelpText(): string {
  return [
    '<b>Shit Go Where?</b> in this group:',
    [
      '/toilet &lt;place&gt;: top 3 toilets near a place, e.g. <code>/toilet bishan mrt</code>',
      '/go: find the closest one near you (opens a private chat, so the group never sees your location)',
      '/filters: filters for this group\'s searches',
      '/privacy: what I keep',
    ].join('\n'),
  ].join('\n\n');
}

export function privacyText(policyLink: string): string {
  return [
    '<b>Privacy</b>',
    'I keep: this chat\'s id and type, your saved filters, when you last used me, and the account id if you link one.',
    'I don\'t keep: names, usernames, phone numbers, your messages or your location. A location you send is used for that one search (and to check you\'re within 150 m when you check in), then dropped. A check-in stores only the distance.',
    'Check-ins and reports from this chat are saved under a scrambled id that can\'t be traced back to the chat without our server key.',
    'In groups, privacy mode is on: I only see commands sent to me and replies to my messages.',
    `/stop deletes this chat's data. Full policy: ${link(policyLink, 'privacy page')}`,
  ].join('\n\n');
}

export const COPY = {
  askLocation: '📍 Send your location with the button below.',
  typePlace: 'Type a place: a mall, MRT station, street or postal code.',
  goPrivate: '🚨 Urgent mode on for 2 minutes. Send your location now and I show the closest toilets only.',
  goGroup: 'Share your location with me in a private chat, so the group can\'t see where you are.',
  locationInGroup:
    'Eh, don\'t share your location in the group, everyone can see it. Tap below and send it to me privately.',
  outsideSingapore: 'Wah, that\'s outside Singapore. I only know toilets in Singapore for now.',
  error: 'Aiyo, something went wrong on my side. Try again in a bit.',
  slowDown: 'Wah, slow down a bit. Try again in a minute.',
  dailyLimit: 'That\'s a lot of toilet hunting for one day. Try again tomorrow.',
  unknownCommand: 'Don\'t know that one. Try /help.',
  toiletNeedsPlace: 'Tell me where, e.g. <code>/toilet bishan mrt</code>.',
  stopped:
    'Done, I\'ve forgotten this chat: its filters and any account link are deleted. Contributions already made stay, under the scrambled id. Send /start any time to come back.',
  unlinked: 'Unlinked. New check-ins from this chat stay anonymous again.',
  notLinked: 'This chat isn\'t linked to a Shit Go Where account.',
  privateOnly: 'That only works in a private chat with me.',
  linkExpired:
    'That link has expired or was already used. Get a new one on the website: Me, then Connect Telegram.',
  checkInStale:
    'That was more than 10 minutes ago. When you\'re at the toilet, send your location again and tap I\'m here.',
  checkInLimit: 'That\'s 5 check-ins from this chat today. Try again tomorrow.',
  reportLimit: 'That\'s 10 reports from this chat today. Try again tomorrow.',
  toiletGone: 'Can\'t find that toilet any more.',
  pendingNeedsAccount:
    'This toilet is new and needs a check-in from a linked account to confirm it. Link this chat first: on the website, open Me and tap Connect Telegram.',
  reportWhich: 'What\'s it like right now?',
  pickGone: 'This toilet is no longer in the results. Send your location again.',
} as const;

export function emptyText(o: { radiusKm: number; filters: FilterState; mapLink: string }): string {
  const lines = [`Eh, nothing within ${o.radiusKm} km leh.`];
  const summary = filtersSummary(o.filters);
  if (summary) lines.push(`Your filters (${escapeHtml(summary)}) may be hiding some. Change them with /filters.`);
  lines.push(`Try another spot, or look on the ${link(o.mapLink, 'full map')}.`);
  return lines.join('\n');
}

export function placeNotFoundText(query: string): string {
  return `Cannot find "${escapeHtml(query)}" leh. Try a mall, MRT station, street or postal code.`;
}

export function errorText(mapLink: string): string {
  return `${COPY.error} Or use the ${link(mapLink, 'full map')}.`;
}

export interface CheckInView {
  distanceM: number;
  pointsAwarded: number;
  bankedPoints: number;
  newBadges: { name: string }[];
  confirmedPending: boolean;
  wentLive: boolean;
}

export function checkInText(title: string, r: CheckInView, linked: boolean): string {
  const lines = [`✅ <b>Checked in</b> at ${escapeHtml(title)} (${formatDistance(r.distanceM)} away). Steady lah!`];
  if (linked && r.pointsAwarded > 0) lines.push(`+${plural(r.pointsAwarded, 'point')}.`);
  if (!linked && r.bankedPoints > 0) lines.push(`${plural(r.bankedPoints, 'point')} banked for this chat.`);
  if (r.newBadges.length) lines.push(`New badge: ${r.newBadges.map((b) => escapeHtml(b.name)).join(', ')} 🏅`);
  if (r.wentLive) lines.push('Your check-in confirmed this new toilet. It\'s live now!');
  else if (r.confirmedPending) lines.push('Your check-in counts towards confirming this new toilet.');
  return lines.join('\n');
}

export function reportText(kind: StatusKind, title: string, unconfirmed: boolean): string {
  const lines = [`Thanks! Reported <b>${STATUS_LABELS[kind]}</b> at ${escapeHtml(title)}.`];
  if (unconfirmed) lines.push('It shows on the map once someone else confirms it.');
  return lines.join('\n');
}

/** GROWTH 3.3: after an unlinked chat's 3rd contribution, then every 5th. */
export function shouldNudge(contributions: number): boolean {
  return contributions === 3 || (contributions > 3 && contributions % 5 === 0);
}

export function nudgeText(points: number): string {
  return `You have ${plural(points, 'point')} waiting. Link your account to keep them: on the website (in your phone's browser), open Me and tap Connect Telegram.`;
}

export function linkedText(handle: string | null, points: number): string {
  const who = handle ? `Linked as <b>@${escapeHtml(handle)}</b>.` : 'Linked to your Shit Go Where account.';
  const moved = points > 0 ? ` ${plural(points, 'point')} moved over. Shiok!` : '';
  return `${who}${moved}\nCheck-ins and reports from this chat now earn points and badges on your account. /unlink to undo.`;
}

// ───────────────────────────── bot profile (telegram:setup) ─────────────────────────────

/** Updates the bot asks Telegram for, webhook and polling alike. */
export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'] as const;

export const PRIVATE_COMMANDS = [
  { command: 'go', description: 'Urgent: closest toilet to your next location' },
  { command: 'toilet', description: 'Toilets near a place, e.g. /toilet bishan mrt' },
  { command: 'filters', description: 'Always need accessible, bidet, free? Set it once' },
  { command: 'help', description: 'How to use the bot' },
  { command: 'privacy', description: 'What the bot keeps about this chat' },
  { command: 'unlink', description: 'Disconnect your Shit Go Where account' },
  { command: 'stop', description: 'Forget this chat' },
];

export const GROUP_COMMANDS = [
  { command: 'toilet', description: 'Toilets near a place, e.g. /toilet bishan mrt' },
  { command: 'go', description: 'Find the closest toilet near you (private chat)' },
  { command: 'filters', description: 'Filters for this group' },
  { command: 'privacy', description: 'What the bot keeps' },
];

/** BotFather "description": the empty-chat screen, up to 512 characters. */
export const BOT_DESCRIPTION =
  'Need to go? Send your location and I find the nearest clean toilet in Singapore: walk time, cleanliness score, live reports (no paper, long queue) and what is inside (bidet, accessible, baby change). No sign-up. Can\'t share your location? Just type a place.';

/** BotFather "about": the profile line, up to 120 characters. */
export const BOT_SHORT_DESCRIPTION = 'Nearest clean toilet in Singapore. Send your location, get the top 3 with walk time and cleanliness.';
