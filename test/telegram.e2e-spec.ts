/**
 * Telegram bot through its webhook (BOT.md §6): fake updates in, Bot API calls out. The Bot API is
 * a local stub HTTP server (TELEGRAM_API_ROOT), OneMap search is stubbed on the service, and the
 * database is the finder fixture. Env must be set before src/config/env.ts is first imported, so
 * everything app-related is imported dynamically.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

const TOKEN = '123456:e2e-telegram-token';
const SECRET = 'e2e-telegram-webhook-secret-0123456789';
const BOT = 'sgw_e2e_bot';
const CHAT = 700_000_001;
const LINK_CHAT = 700_000_002;
const GROUP = -100_700_000_003;
/** Each chat may send 20 updates a minute, so the last test uses a fresh one. */
const OTHER = 700_000_004;
/** Place searches and urgent flows run here: CHAT would hit the 20 updates a minute limit. */
const EXTRA = 700_000_005;

interface ApiCall {
  method: string;
  body: Record<string, any>;
}

describe('Telegram bot (e2e)', () => {
  let stub: Server;
  let calls: ApiCall[] = [];
  let app: INestApplication;
  let prisma: any;
  let env: any;
  let fx: any;
  let origin: { lat: number; lng: number };
  let hashTelegramId: (chatId: number | string, secret: string) => string;
  let cookieFor: (userId: string) => string;
  let updateId = 1;
  const http = () => request(app.getHttpServer());

  // ───────────── helpers ─────────────

  const now = () => Math.floor(Date.now() / 1000);
  const chatOf = (id: number) =>
    id < 0 ? { id, type: 'supergroup', title: 'Makan kakis' } : { id, type: 'private', first_name: 'Tester' };
  const from = (id: number) => ({ id: Math.abs(id), is_bot: false, first_name: 'Tester' });

  function message(chatId: number, extra: Record<string, unknown>) {
    const id = updateId++;
    return {
      update_id: id,
      message: { message_id: id, date: now(), chat: chatOf(chatId), from: from(chatId), ...extra },
    };
  }
  const text = (chatId: number, t: string) =>
    message(chatId, t.startsWith('/') ? { text: t, entities: [{ type: 'bot_command', offset: 0, length: t.split(' ')[0]!.length }] } : { text: t });
  const location = (chatId: number, p: { lat: number; lng: number }) =>
    message(chatId, { location: { latitude: p.lat, longitude: p.lng } });
  function callback(chatId: number, data: string, inlineKeyboard: unknown[][] = [], date = now()) {
    const id = updateId++;
    return {
      update_id: id,
      callback_query: {
        id: String(id),
        from: from(chatId),
        chat_instance: 'e2e',
        data,
        message: {
          message_id: 9000 + id,
          date,
          chat: chatOf(chatId),
          text: 'results',
          reply_markup: { inline_keyboard: inlineKeyboard },
        },
      },
    };
  }

  /** Posts one update and returns the Bot API calls it made. */
  async function send(update: object): Promise<ApiCall[]> {
    calls = [];
    await http().post('/integrations/telegram').set('X-Telegram-Bot-Api-Secret-Token', SECRET).send(update).expect(200);
    return calls;
  }
  const messages = (c: ApiCall[]) => c.filter((x) => x.method === 'sendMessage').map((x) => x.body);
  /** Messages the bot edited in place (a button tap that changes what is on screen). */
  const edits = (c: ApiCall[]) => c.filter((x) => x.method === 'editMessageText').map((x) => x.body);
  /** Searches counted so far, over every toilet: moves once per search answer, never on Back or a pick. */
  const routeTotal = async (): Promise<number> =>
    (await prisma.toiletRouteDaily.findMany()).reduce((n: number, r: { count: number }) => n + r.count, 0);
  const inlineButtons = (body: Record<string, any>): { text: string; url?: string; callback_data?: string }[] =>
    (body.reply_markup?.inline_keyboard ?? []).flat();

  // ───────────── setup ─────────────

  beforeAll(async () => {
    stub = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const method = (req.url ?? '').split('/').pop() ?? '';
        const body = raw ? (JSON.parse(raw) as Record<string, any>) : {};
        calls.push({ method, body });
        const result =
          method === 'sendMessage'
            ? { message_id: calls.length, date: now(), chat: { id: body.chat_id, type: 'private' }, text: body.text }
            : true;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, result }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const port = (stub.address() as AddressInfo).port;

    Object.assign(process.env, {
      NODE_ENV: 'test',
      AUTH_SECRET: process.env.AUTH_SECRET || 'e2e-auth-secret-at-least-16',
      PUBLIC_APP_URL: 'http://app.test',
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      TELEGRAM_BOT_USERNAME: BOT,
      TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
      // Nothing leaves the machine: no PostHog, no OneMap routing.
      POSTHOG_KEY: '',
      ONEMAP_EMAIL: '',
      ONEMAP_PASSWORD: '',
    });

    ({ env } = await import('../src/config/env.js'));
    ({ hashTelegramId } = await import('../src/analytics/analytics.js'));
    const { createApp } = await import('../src/app.factory.js');
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { OneMapService } = await import('../src/routing/onemap.service.js');
    const finder = await import('./fixtures/finder.js');
    cookieFor = finder.cookieFor;
    origin = finder.ORIGIN;

    app = await createApp();
    await app.init();
    prisma = app.get(PrismaService);
    fx = await finder.seedFinder(prisma);

    // OneMap search: "bishan" is Test Station's spot; anything else is unknown.
    const station = finder.offset(-600);
    const onemap = app.get(OneMapService);
    onemap.credentials = null;
    onemap.fetchFn = (async (url: URL | string) => {
      const q = new URL(String(url)).searchParams.get('searchVal') ?? '';
      const results = /bishan/i.test(q)
        ? [{ SEARCHVAL: 'BISHAN MRT STATION (NS17)', ADDRESS: '200 BISHAN ROAD', LATITUDE: String(station.lat), LONGITUDE: String(station.lng) }]
        : [];
      return new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterAll(async () => {
    if (prisma) {
      const { resetDb } = await import('./fixtures/finder.js');
      await resetDb(prisma);
    }
    await app?.close();
    await new Promise((r) => stub?.close(r));
  });

  // ───────────── webhook ─────────────

  it('rejects updates without the right secret', async () => {
    await http().post('/integrations/telegram').send(text(CHAT, '/start')).expect(401);
    await http()
      .post('/integrations/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', 'wrong')
      .send(text(CHAT, '/start'))
      .expect(401);
    expect(calls).toEqual([]);
  });

  it('is not in the public API spec', async () => {
    const spec = await http().get('/openapi.json').expect(200);
    expect(Object.keys(spec.body.paths)).not.toContain('/integrations/telegram');
  });

  // ───────────── T1, T2, T3 ─────────────

  it('/start onboards with a location button and creates the chat row', async () => {
    const out = messages(await send(text(CHAT, '/start')));
    expect(out).toHaveLength(1);
    expect(out[0]!.chat_id).toBe(CHAT);
    expect(out[0]!.parse_mode).toBe('HTML');
    expect(out[0]!.text).toContain('Shit Go Where?');
    expect(out[0]!.reply_markup.keyboard[0][0]).toMatchObject({ text: '📍 Send my location', request_location: true });
    // Only the location button: typing a place needs no button.
    expect(out[0]!.reply_markup.keyboard).toHaveLength(1);
    expect(out[0]!.reply_markup.input_field_placeholder).toBe('or type a place, e.g. Bishan MRT');
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(CHAT) } });
    expect(row).toMatchObject({ type: 'PRIVATE', userId: null, filters: [] });
  });

  let pickData = '';
  let backData = '';
  let checkInData = '';
  let resultKeyboard: unknown[][] = [];

  it('a location gets the top 3 as a list with one pick button each, and counts a route to the top one', async () => {
    const c = await send(location(CHAT, origin));
    expect(c[0]).toMatchObject({ method: 'sendChatAction', body: { action: 'typing' } });
    const [reply] = messages(c);
    expect(reply!.text).toContain('Top 3 near you');
    expect(reply!.text).toContain('1. <a href=');
    expect(reply!.text).toContain('Test Mall · L1 near lifts</a>');
    expect(reply!.text).toContain('Nearby but no toilet');
    // The title links to the details page; the keyboard has no URL buttons.
    expect(reply!.text).toContain(
      `${env.PUBLIC_APP_URL}/toilets/${fx.toilets.a1.id}?utm_source=telegram&amp;utm_medium=bot&amp;utm_campaign=near`,
    );
    const buttons = inlineButtons(reply!);
    expect(buttons.some((b) => b.url)).toBe(false);
    expect(buttons).toHaveLength(5);
    expect(buttons[0]!.text).toMatch(/^1\. Test Mall · L1 near lifts · \d+ min$/);
    pickData = buttons[0]!.callback_data!;
    expect(pickData.startsWith(`p:c,${fx.toilets.a1.id},1.3510,103.8480,`)).toBe(true);
    expect(buttons[1]!.callback_data!.startsWith('p:c,')).toBe(true);
    expect(buttons[2]!.callback_data!.startsWith('p:c,')).toBe(true);
    expect(buttons[3]).toMatchObject({ text: '🚨 Nearest only', callback_data: 'u:1.3510,103.8480' });
    expect(buttons[4]).toMatchObject({ text: '🎛 Filters', callback_data: 'f:*' });
    resultKeyboard = reply!.reply_markup.inline_keyboard;
    const routed = await prisma.toiletRouteDaily.findMany({ where: { toiletId: fx.toilets.a1.id } });
    expect(routed.map((r: { count: number }) => r.count)).toEqual([1]);
  });

  it('a pick edits the list into that toilet\'s card, and Back edits it into the list again', async () => {
    const before = await routeTotal();
    const c = await send(callback(CHAT, pickData, resultKeyboard));
    expect(c.some((x) => x.method === 'answerCallbackQuery')).toBe(true);
    expect(messages(c)).toEqual([]);
    const [card] = edits(c);
    expect(card!.parse_mode).toBe('HTML');
    expect(card!.text).toContain('Test Mall · L1 near lifts</a></b>');
    expect(card!.text).not.toContain('1. ');
    const rows = card!.reply_markup.inline_keyboard as { text: string; url?: string; callback_data?: string }[][];
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([
      ['🧭 Navigate ↗', 'ℹ️ Details ↗'],
      ["✅ I'm here", '⚠️ Report'],
      ['◀ Back to list'],
    ]);
    expect(rows[0]![0]!.url).toContain('dir_action=navigate');
    expect(rows[0]![1]!.url).toBe(`${env.PUBLIC_APP_URL}/toilets/${fx.toilets.a1.id}?utm_source=telegram&utm_medium=bot&utm_campaign=near`);
    checkInData = rows[1]![0]!.callback_data!;
    expect(checkInData.startsWith(`c:${fx.toilets.a1.id},1.3510,103.8480,`)).toBe(true);
    expect(rows[1]![1]!.callback_data).toBe(`r:${fx.toilets.a1.id}`);
    backData = rows[2]![0]!.callback_data!;
    expect(backData.startsWith('l:c,1.3510,103.8480,')).toBe(true);

    const back = await send(callback(CHAT, backData));
    expect(messages(back)).toEqual([]);
    const [list] = edits(back);
    expect(list!.text).toContain('Top 3 near you');
    expect(inlineButtons(list!).map((b) => b.callback_data)).toContain(pickData);
    // Neither is a new search.
    expect(await routeTotal()).toBe(before);
  });

  it('a pick that is no longer in the results says so instead of guessing', async () => {
    const data = 'p:c,cmgone000000000000000000,1.3510,103.8480';
    const [gone] = edits(await send(callback(EXTRA, data)));
    expect(gone!.text).toContain('no longer in the results');
    expect(gone!.reply_markup).toBeUndefined();
  });

  it('a location outside Singapore is answered honestly', async () => {
    const [reply] = messages(await send(location(CHAT, { lat: 51.5, lng: -0.12 })));
    expect(reply!.text).toContain('outside Singapore');
  });

  // ───────────── T5 ─────────────

  it('typed text searches OneMap and answers near the place, without check-in on its picks', async () => {
    const [reply] = messages(await send(text(EXTRA, 'bishan')));
    expect(reply!.text).toContain('Toilets near Bishan MRT Station (NS17)');
    expect(reply!.text).toContain(`${env.PUBLIC_APP_URL}/stations/test-station?utm_source=telegram&amp;utm_medium=bot&amp;utm_campaign=search`);
    const buttons = inlineButtons(reply!);
    const picks = buttons.filter((b) => b.callback_data?.startsWith('p:'));
    expect(picks.length).toBeGreaterThan(0);
    // A searched place is not where the person stands: no minute in the data, so no "I'm here" on the card.
    expect(picks.every((b) => b.callback_data!.split(',').length === 4)).toBe(true);
    expect(buttons.some((b) => b.callback_data?.startsWith('c:'))).toBe(false);
    expect(buttons.at(-1)).toMatchObject({ text: '🎛 Filters', callback_data: 'f:*' });

    const [card] = edits(await send(callback(EXTRA, picks[0]!.callback_data!)));
    const cardButtons = inlineButtons(card!);
    expect(cardButtons.some((b) => b.text.includes("I'm here"))).toBe(false);
    expect(cardButtons.some((b) => b.callback_data?.startsWith('r:'))).toBe(true);
    expect(cardButtons.some((b) => b.text === '◀ Back to list')).toBe(true);

    const [none] = messages(await send(text(EXTRA, 'atlantis')));
    expect(none!.text).toContain('Cannot find "atlantis"');
  });

  // ───────────── T4 ─────────────

  it('/go makes the next location urgent, once, and answers with the closest toilet\'s card', async () => {
    const [go] = messages(await send(text(EXTRA, '/go')));
    expect(go!.text).toContain('Urgent mode');
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(EXTRA) } });
    expect(row.urgentUntil.getTime()).toBeGreaterThan(Date.now());

    const before = await routeTotal();
    const [urgent] = messages(await send(location(EXTRA, origin)));
    expect(urgent!.text.startsWith('🚨 <b>Closest to you</b>\n<b><a href=')).toBe(true);
    expect(urgent!.text).not.toContain('Unconfirmed');
    expect(urgent!.text).not.toContain('1. ');
    const rows = urgent!.reply_markup.inline_keyboard as { text: string; callback_data?: string }[][];
    const labels = rows.map((r) => r.map((b) => b.text));
    expect(labels.slice(0, 2)).toEqual([
      ['🧭 Navigate ↗', 'ℹ️ Details ↗'],
      ["✅ I'm here", '⚠️ Report'],
    ]);
    expect(labels.flat().some((l) => l.includes('Back to list'))).toBe(false);
    const more = rows[2]![0]!;
    expect(more.text).toMatch(/^📋 See \d+ more$/);
    expect(more.callback_data!.startsWith('l:u,1.3510,103.8480,')).toBe(true);
    expect(await routeTotal()).toBe(before + 1);
    const after = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(EXTRA) } });
    expect(after.urgentUntil).toBeNull();

    // "See more": the urgent list in walking order, with pick buttons and no "Nearest only".
    const seeMore = await send(callback(EXTRA, more.callback_data!));
    expect(messages(seeMore)).toEqual([]);
    const [list] = edits(seeMore);
    expect(list!.text.startsWith('🚨 <b>Closest to you</b>, by walking time')).toBe(true);
    const listButtons = inlineButtons(list!);
    expect(listButtons.some((b) => b.text.includes('Nearest only'))).toBe(false);
    expect(listButtons.at(-1)).toMatchObject({ text: '🎛 Filters', callback_data: 'f:*' });
    const picks = listButtons.filter((b) => b.callback_data?.startsWith('p:u,'));
    expect(picks.length).toBeGreaterThan(1);

    // A pick from it opens the card, now with Back to the urgent list.
    const [card] = edits(await send(callback(EXTRA, picks[1]!.callback_data!)));
    const back = inlineButtons(card!).find((b) => b.text === '◀ Back to list')!;
    expect(back.callback_data!.startsWith('l:u,1.3510,103.8480,')).toBe(true);
    expect(card!.text.startsWith('<b><a href=')).toBe(true);
    expect(await routeTotal()).toBe(before + 1);
  });

  it('"Nearest only" edits the list into the closest toilet\'s card, counts as a new search and keeps I\'m here', async () => {
    const before = await routeTotal();
    const c = await send(callback(EXTRA, 'u:1.3510,103.8480', resultKeyboard));
    expect(c.some((x) => x.method === 'answerCallbackQuery')).toBe(true);
    expect(messages(c)).toEqual([]);
    const [card] = edits(c);
    expect(card!.text.startsWith('🚨 <b>Closest to you</b>')).toBe(true);
    const buttons = inlineButtons(card!);
    expect(buttons.some((b) => b.callback_data?.startsWith('c:'))).toBe(true);
    expect(buttons.some((b) => b.text === '◀ Back to list')).toBe(false);
    expect(await routeTotal()).toBe(before + 1);

    // A list from a searched place has no minute, so its card has no "I'm here".
    const placeList = [[{ text: 'x', callback_data: `p:c,${fx.toilets.a1.id},1.3510,103.8480` }]];
    const [placeCard] = edits(await send(callback(EXTRA, 'u:1.3510,103.8480', placeList)));
    expect(inlineButtons(placeCard!).some((b) => b.callback_data?.startsWith('c:'))).toBe(false);
  });

  // ───────────── T6, T7 ─────────────

  it('"I\'m here" checks in anonymously under the hashed chat id', async () => {
    const c = await send(callback(CHAT, checkInData));
    expect(c.find((x) => x.method === 'answerCallbackQuery')!.body.text).toBe('Checked in!');
    // The card is edited into the check-in confirmation and the status picker.
    expect(messages(c)).toEqual([]);
    const [reply] = edits(c);
    expect(reply!.text.startsWith('<b>Test Mall · L1 near lifts</b>\n\n')).toBe(true);
    expect(reply!.text).toContain('Checked in');
    expect(reply!.text).toContain('4 points banked for this chat');
    expect(reply!.text).toContain("What's it like right now?");
    expect(inlineButtons(reply!).map((b) => b.callback_data)).toContain(`r:${fx.toilets.a1.id},NO_PAPER`);

    const deviceId = hashTelegramId(CHAT, env.AUTH_SECRET);
    const rows = await prisma.checkIn.findMany({ where: { toiletId: fx.toilets.a1.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceId, userId: null });
    expect(rows[0].distanceM).toBeLessThanOrEqual(150);

    // A retry of the same tap is caught by the service's cooldown.
    const [again] = messages(await send(callback(CHAT, checkInData)));
    expect(again!.text).toContain('already checked in here');
  });

  it('a check-in tap older than 10 minutes asks for a fresh location', async () => {
    const old = Math.floor(Date.now() / 60_000) - 11;
    const data = `c:${fx.toilets.b1.id},1.3510,103.8480,${old.toString(36)}`;
    const [reply] = messages(await send(callback(CHAT, data)));
    expect(reply!.text).toContain('more than 10 minutes ago');
    expect(await prisma.checkIn.count({ where: { toiletId: fx.toilets.b1.id } })).toBe(0);
  });

  it('a check-in too far away says so', async () => {
    const data = `c:${fx.toilets.b1.id},1.3510,103.8480,${Math.floor(Date.now() / 60_000).toString(36)}`;
    const [reply] = messages(await send(callback(CHAT, data)));
    expect(reply!.text).toMatch(/You are \d+ m from this toilet/);
  });

  it('"Report" shows the status buttons, and a status tap files an anonymous report', async () => {
    const askCalls = await send(callback(CHAT, `r:${fx.toilets.a1.id}`));
    expect(messages(askCalls)).toEqual([]);
    const [ask] = edits(askCalls);
    expect(ask!.text).toBe("<b>Test Mall · L1 near lifts</b>\n\nWhat's it like right now?");
    expect(inlineButtons(ask!)).toHaveLength(7);
    expect(inlineButtons(ask!)[1]!.text).toBe('🧻 No paper');

    const c = await send(callback(CHAT, `r:${fx.toilets.a1.id},NO_PAPER`));
    expect(c.find((x) => x.method === 'answerCallbackQuery')!.body.text).toBe('Thanks!');
    expect(messages(c)).toEqual([]);
    const [reply] = edits(c);
    expect(reply!.text.startsWith('<b>Test Mall · L1 near lifts</b>\n\n')).toBe(true);
    expect(reply!.text).toContain('Reported <b>No paper</b>');
    // Only a way to get there is left.
    expect(inlineButtons(reply!)).toHaveLength(1);
    expect(inlineButtons(reply!)[0]!.url).toContain('dir_action=navigate');
    const reports = await prisma.statusReport.findMany({ where: { toiletId: fx.toilets.a1.id } });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: 'NO_PAPER', deviceId: hashTelegramId(CHAT, env.AUTH_SECRET), userId: null });
  });

  // ───────────── T8 ─────────────

  it('/filters toggles saved filters in place', async () => {
    const [menu] = messages(await send(text(CHAT, '/filters')));
    expect(inlineButtons(menu!)[1]).toMatchObject({ text: '⬜️ Bidet', callback_data: 'f:BIDET' });

    // The Filters button on an answer opens the menu as a new message, so the answer stays.
    const open = await send(callback(CHAT, 'f:*', resultKeyboard));
    expect(edits(open)).toEqual([]);
    const [opened] = messages(open);
    expect(opened!.text).toContain('<b>Filters</b>');
    expect(inlineButtons(opened!)[1]).toMatchObject({ text: '⬜️ Bidet', callback_data: 'f:BIDET' });

    const c = await send(callback(CHAT, 'f:BIDET'));
    const edit = c.find((x) => x.method === 'editMessageText')!;
    expect(inlineButtons(edit.body)[1]!.text).toBe('✅ Bidet');
    let row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(CHAT) } });
    expect(row.filters).toEqual(['BIDET']);

    // Saved filters apply: only a1 has a bidet, and the answer says filters are on.
    const [reply] = messages(await send(location(CHAT, origin)));
    expect(reply!.text).toContain('Filters: bidet');
    expect(reply!.text).toContain('Best one near you');

    await send(callback(CHAT, 'f:BIDET'));
    row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(CHAT) } });
    expect(row.filters).toEqual([]);
  });

  // ───────────── T15 ─────────────

  it('links an account from POST /me/telegram/link-token and moves banked points', async () => {
    const user = fx.users.u1;
    // This chat has an anonymous check-in banked (1 + 3 points).
    const deviceId = hashTelegramId(LINK_CHAT, env.AUTH_SECRET);
    await prisma.checkIn.create({ data: { deviceId, toiletId: fx.toilets.b1.id, distanceM: 20 } });

    await http().post('/me/telegram/link-token').expect(401);
    const res = await http().post('/me/telegram/link-token').set('Cookie', cookieFor(user.id)).expect(200);
    expect(res.body.url.startsWith(`https://t.me/${BOT}?start=link_`)).toBe(true);
    expect(new Date(res.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    const payload = new URL(res.body.url).searchParams.get('start')!;
    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    expect(stored.telegramLinkTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.telegramLinkTokenHash).not.toContain(payload.slice(5));

    const [reply] = messages(await send(text(LINK_CHAT, `/start ${payload}`)));
    expect(reply!.text).toContain('Linked as <b>@user_one</b>. 4 points moved over.');
    const chat = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(LINK_CHAT) } });
    expect(chat.userId).toBe(user.id);
    expect(await prisma.checkIn.count({ where: { deviceId } })).toBe(0);
    expect(await prisma.checkIn.count({ where: { userId: user.id } })).toBe(1);
    const cleared = await prisma.user.findUnique({ where: { id: user.id } });
    expect(cleared.telegramLinkTokenHash).toBeNull();

    const me = await http().get('/me').set('Cookie', cookieFor(user.id)).expect(200);
    expect(me.body.telegramLinked).toBe(true);

    // One use only.
    const [reuse] = messages(await send(text(LINK_CHAT, `/start ${payload}`)));
    expect(reuse!.text).toContain('expired or was already used');
  });

  it('a linked chat checks in as the user, and DELETE /me/telegram unlinks', async () => {
    const user = fx.users.u1;
    const data = `c:${fx.toilets.a1.id},1.3510,103.8480,${Math.floor(Date.now() / 60_000).toString(36)}`;
    const [reply] = edits(await send(callback(LINK_CHAT, data)));
    expect(reply!.text).toContain('Checked in');
    expect(reply!.text).toContain('+4 points');
    expect(await prisma.checkIn.count({ where: { userId: user.id, toiletId: fx.toilets.a1.id } })).toBe(1);

    await http().delete('/me/telegram').set('Cookie', cookieFor(user.id)).expect(204);
    const me = await http().get('/me').set('Cookie', cookieFor(user.id)).expect(200);
    expect(me.body.telegramLinked).toBe(false);
    const [unlink] = messages(await send(text(LINK_CHAT, '/unlink')));
    expect(unlink!.text).toContain("isn't linked");
  });

  // ───────────── §4 groups ─────────────

  it('groups get /toilet <place> with Navigate links and Filters only, and no location sharing', async () => {
    const [reply] = messages(await send(text(GROUP, '/toilet@sgw_e2e_bot bishan')));
    expect(reply!.text).toContain('Toilets near Bishan MRT Station');
    expect(reply!.text).toContain(`${env.PUBLIC_APP_URL}/toilets/`);
    const buttons = inlineButtons(reply!);
    const navigate = buttons.filter((b) => b.url !== undefined);
    expect(navigate).toHaveLength(3);
    expect(navigate.every((b) => b.text.startsWith('🧭 ') && b.text.endsWith(' ↗'))).toBe(true);
    expect(navigate.every((b) => b.url!.includes('dir_action=navigate'))).toBe(true);
    expect(buttons.filter((b) => b.url === undefined)).toEqual([{ text: '🎛 Filters', callback_data: 'f:*' }]);

    // Filters work in a group (as a new message); check-ins, reports and cards do not exist there.
    const filters = await send(callback(GROUP, 'f:*'));
    expect(messages(filters)[0]!.text).toContain('<b>Filters</b>');
    for (const data of [`p:c,${fx.toilets.a1.id},1.3510,103.8480`, 'l:c,1.3510,103.8480', `r:${fx.toilets.a1.id}`, 'u:1.3510,103.8480']) {
      const c = await send(callback(GROUP, data));
      expect(c.map((x) => x.method)).toEqual(['answerCallbackQuery']);
    }

    const [go] = messages(await send(text(GROUP, '/go')));
    expect(inlineButtons(go!)[0]!.url).toBe(`https://t.me/${BOT}?start=go`);

    const [loc] = messages(await send(location(GROUP, origin)));
    expect(loc!.text).toContain("don't share your location in the group");
    const row = await prisma.telegramChat.findUnique({ where: { chatId: BigInt(GROUP) } });
    expect(row.type).toBe('SUPERGROUP');
  });

  // ───────────── T10 ─────────────

  it('/privacy links the privacy page and /stop deletes the chat row', async () => {
    await send(text(OTHER, '/start'));
    const [privacy] = messages(await send(text(OTHER, '/privacy')));
    expect(privacy!.text).toContain(`${env.PUBLIC_APP_URL}/privacy?`);
    expect(privacy!.text).toContain("I don't keep");

    expect(await prisma.telegramChat.findUnique({ where: { chatId: BigInt(OTHER) } })).not.toBeNull();
    const [stop] = messages(await send(text(OTHER, '/stop')));
    expect(stop!.text).toContain('forgotten this chat');
    expect(await prisma.telegramChat.findUnique({ where: { chatId: BigInt(OTHER) } })).toBeNull();
  });
});
