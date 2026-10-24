import type { RecommendItem } from '../../routing/recommend.service.js';
import {
  CALLBACK_MAX_BYTES,
  checkInText,
  decodeCallback,
  emptyText,
  encodeCallback,
  escapeHtml,
  filtersMessage,
  filtersSummary,
  formatCard,
  formatItem,
  formatResults,
  lastCheckedText,
  linkedText,
  minuteFromKeyboard,
  pickLabel,
  placeNotFoundText,
  STATUS_ICONS,
  statusKeyboard,
  tidyPlaceName,
  toggleFilter,
  toiletTitle,
  verdictWord,
  type CardOptions,
  type FilterState,
  type ResultsOptions,
} from './format.js';

const NOW = new Date('2026-10-20T04:00:00Z');
const BASE = 'https://app.example';
const NO_FILTERS: FilterState = { filters: [], areaType: null, openNow: false };
const ID = 'cmabcdefghijklmnopqrstuvw'; // cuid length (25)

function item(over: Partial<RecommendItem['toilet']> = {}, extra: Partial<RecommendItem> = {}): RecommendItem {
  return {
    toilet: {
      id: ID,
      label: 'L1 near lifts',
      venue: {
        id: 'v1',
        name: 'Test Mall',
        type: 'MALL',
        lines: [],
        lat: 1.351,
        lng: 103.848,
        toiletStatus: 'HAS_TOILETS',
        note: null,
      },
      lat: 1.3519,
      lng: 103.8481,
      level: 'L1',
      areaType: 'UNKNOWN',
      tier: 'VERIFIED',
      status: 'ACTIVE',
      features: ['TOILET_PAPER', 'BIDET', 'ACCESSIBLE', 'MIRROR'],
      sex: null,
      scoreCleanliness: 8.2,
      surveyTotal: 40,
      rasStars: null,
      reviewCount: 0,
      seenBy: 1,
      activeStatus: [],
      lastVerifiedAt: '2024-03-15T00:00:00.000Z',
      needsResurvey: false,
      openNow: true,
      photoThumb: null,
      ...over,
    },
    score: 0.8,
    walkSeconds: 170,
    walkDistanceM: 236,
    reasons: [],
    route: null,
    unconfirmed: false,
    ...extra,
  };
}

const opts = (over: Partial<ResultsOptions> = {}): ResultsOptions => ({
  appBase: BASE,
  urgent: false,
  origin: { lat: 1.351, lng: 103.848 },
  campaign: 'near',
  group: false,
  checkInMinute: 29_000_000,
  filters: NO_FILTERS,
  now: NOW,
  ...over,
});

const buttons = (kb: { inline_keyboard: { text: string }[][] }) => kb.inline_keyboard.flat();

describe('escapeHtml', () => {
  it('escapes the characters Telegram HTML cares about', () => {
    expect(escapeHtml('<b>"A&B"</b>')).toBe('&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;');
  });
});

describe('callback data', () => {
  it('round-trips every kind within 64 bytes', () => {
    const cases = [
      { kind: 'urgent', lat: 1.35123, lng: 103.84811 },
      { kind: 'checkin', toiletId: ID, lat: 1.3512, lng: 103.8481, minute: 29_345_678 },
      { kind: 'report', toiletId: ID },
      { kind: 'report', toiletId: ID, status: 'BEING_CLEANED' },
      { kind: 'filter', key: 'NURSING_ROOM' },
      { kind: 'filtersMenu' },
      { kind: 'pick', urgent: false, toiletId: ID, lat: 1.3512, lng: 103.8481, minute: 29_345_678 },
      { kind: 'pick', urgent: true, toiletId: ID, lat: 1.3512, lng: 103.8481 },
      { kind: 'list', urgent: true, lat: 1.3512, lng: 103.8481, minute: 29_345_678 },
      { kind: 'list', urgent: false, lat: 1.3512, lng: 103.8481 },
    ] as const;
    for (const c of cases) {
      const data = encodeCallback(c)!;
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
      const back = decodeCallback(data);
      if (c.kind === 'urgent') expect(back).toEqual({ kind: 'urgent', lat: 1.3512, lng: 103.8481 });
      else expect(back).toEqual(c);
    }
  });

  it('rounds coordinates to 4 dp', () => {
    expect(encodeCallback({ kind: 'urgent', lat: 1.351234, lng: 103.848111 })).toBe('u:1.3512,103.8481');
  });

  it('rejects malformed or unknown data', () => {
    for (const bad of [
      undefined,
      '',
      'x:1',
      'u:1.3',
      'u:abc,def',
      'u:1.3,103.8,9',
      'c:id,1.3,103.8',
      'c:bad id!,1.3,103.8,abc',
      'r:',
      `r:${ID},NOT_A_KIND`,
      'f:SHOWER',
      'f:*,x',
      'u:91.0000,103.8',
      // p: and l: need a strict mode char and the right number of parts
      `p:x,${ID},1.3512,103.8481`,
      `p:c,${ID},1.3512`,
      `p:c,${ID},1.3512,103.8481,abc,extra`,
      `p:c,${ID},1.3512,103.8481,BAD!`,
      'p:c,bad id!,1.3512,103.8481',
      `p:c,${ID},91.0000,103.8481`,
      'l:x,1.3512,103.8481',
      'l:c,1.3512',
      'l:c,1.3512,103.8481,abc,extra',
      'l:c,1.3512,103.8481,BAD!',
      'l:,1.3512,103.8481',
    ]) {
      expect(decodeCallback(bad)).toBeNull();
    }
  });

  it('refuses ids that would not fit', () => {
    expect(encodeCallback({ kind: 'checkin', toiletId: 'x'.repeat(41), lat: 1.35, lng: 103.84, minute: 29_345_678 })).toBeNull();
    expect(encodeCallback({ kind: 'report', toiletId: 'has space' })).toBeNull();
    // 40-char ids are valid, but with a minute a pick no longer fits in 64 bytes.
    const pick = { kind: 'pick', urgent: false, lat: 1.35, lng: 103.84, minute: 29_345_678 } as const;
    expect(encodeCallback({ ...pick, toiletId: 'x'.repeat(41) })).toBeNull();
    expect(encodeCallback({ ...pick, toiletId: 'x'.repeat(40) })).toBeNull();
    expect(encodeCallback({ ...pick, toiletId: ID })).not.toBeNull();
    expect(encodeCallback({ kind: 'pick', urgent: false, toiletId: 'has space', lat: 1.35, lng: 103.84 })).toBeNull();
  });

  it('writes pick and list as documented', () => {
    expect(encodeCallback({ kind: 'pick', urgent: false, toiletId: ID, lat: 1.351, lng: 103.848, minute: 36 })).toBe(
      `p:c,${ID},1.3510,103.8480,10`,
    );
    expect(encodeCallback({ kind: 'list', urgent: true, lat: 1.351, lng: 103.848 })).toBe('l:u,1.3510,103.8480');
    expect(encodeCallback({ kind: 'filtersMenu' })).toBe('f:*');
  });

  it('reads the minute back out of a keyboard', () => {
    const kb = (...data: (string | undefined)[]) => [data.map((d) => ({ text: 'x', callback_data: d }))];
    const minute = (29_000_000).toString(36);
    expect(minuteFromKeyboard(kb('u:1.3510,103.8480', `p:c,${ID},1.3510,103.8480,${minute}`))).toBe(29_000_000);
    expect(minuteFromKeyboard(kb(`l:u,1.3510,103.8480,${minute}`))).toBe(29_000_000);
    // a searched place carries no minute; neither do other kinds or url buttons
    expect(minuteFromKeyboard(kb(`p:c,${ID},1.3510,103.8480`, 'f:*', undefined))).toBeUndefined();
    expect(minuteFromKeyboard([[{ text: 'x' }]])).toBeUndefined();
    expect(minuteFromKeyboard(undefined)).toBeUndefined();
  });
});

describe('filters', () => {
  it('toggles features, the paid area and open now', () => {
    let s = toggleFilter(NO_FILTERS, 'BIDET');
    s = toggleFilter(s, 'ACCESSIBLE');
    s = toggleFilter(s, 'UNPAID');
    s = toggleFilter(s, 'OPEN');
    expect(s).toEqual({ filters: ['BIDET', 'ACCESSIBLE'], areaType: 'UNPAID_AREA', openNow: true });
    expect(filtersSummary(s)).toBe('accessible, bidet, outside paid area, open now');
    s = toggleFilter(toggleFilter(s, 'BIDET'), 'UNPAID');
    expect(s).toEqual({ filters: ['ACCESSIBLE'], areaType: null, openNow: true });
    expect(filtersSummary(NO_FILTERS)).toBeNull();
  });

  it('draws a ticked keyboard', () => {
    const { text, keyboard } = filtersMessage({ filters: ['ACCESSIBLE'], areaType: null, openNow: false });
    expect(text).toContain('On: accessible');
    const b = buttons(keyboard);
    expect(b).toHaveLength(8);
    expect(b[0]).toMatchObject({ text: '✅ Accessible', callback_data: 'f:ACCESSIBLE' });
    expect(b[1]).toMatchObject({ text: '⬜️ Bidet', callback_data: 'f:BIDET' });
  });
});

describe('result entries', () => {
  it('shows venue, walk, tier, score, verdict, features', () => {
    const text = formatItem(item(), 1, NOW);
    expect(text).toBe(
      [
        '<b>1. Test Mall · L1 near lifts</b>',
        '3 min walk · 240 m',
        'Verified · checked 2 years ago',
        'Clean 8.2/10 (Shiok!) · survey 40/50',
        'Accessible, Bidet, Toilet paper',
      ].join('\n'),
    );
  });

  it('adds live status, the paid area and the unconfirmed label', () => {
    const text = formatItem(
      item(
        {
          areaType: 'PAID_AREA',
          activeStatus: [{ kind: 'NO_PAPER', count: 2, latestAt: NOW.toISOString() }],
          scoreCleanliness: null,
          surveyTotal: null,
          features: [],
        },
        { unconfirmed: true },
      ),
      2,
      NOW,
    );
    expect(text).toContain('inside the fare gates');
    expect(text).toContain('⚠️ Now: No paper, 2 reports');
    expect(text).toContain('Unconfirmed');
    expect(text).not.toContain('Clean');
  });

  it('escapes names from the database', () => {
    expect(formatItem(item({ label: '<script>' }), 1, NOW)).toContain('&lt;script&gt;');
  });

  it('links the title to the details page when given one', () => {
    const url = `${BASE}/toilets/${ID}?utm_source=telegram&utm_medium=bot&utm_campaign=near`;
    const first = formatItem(item({ label: '<script>' }), 1, NOW, url).split('\n')[0];
    expect(first).toBe(`<b>1. <a href="${url.replace(/&/g, '&amp;')}">Test Mall · &lt;script&gt; · L1</a></b>`);
  });

  it('cuts a pick label at 28 characters with an ellipsis, then the walk time', () => {
    expect(pickLabel(item(), 1)).toBe('1. Test Mall · L1 near lifts · 3 min');
    // "Test Mall · " is 12 characters, so a 16-character label makes exactly 28: left alone
    expect(pickLabel(item({ label: '1234567890123456', level: null }), 1)).toBe('1. Test Mall · 1234567890123456 · 3 min');
    expect(pickLabel(item({ label: '12345678901234567', level: null }), 2)).toBe('2. Test Mall · 123456789012345… · 3 min');
    const cut = pickLabel(item({ label: 'Level 3 beside the food court escalators' }), 2);
    expect(cut).toBe('2. Test Mall · Level 3 beside… · 3 min');
    expect(cut.slice('2. '.length, -' · 3 min'.length).length).toBeLessThanOrEqual(28);
  });

  it('titles MRT venues and skips a level the label already says', () => {
    const t = { label: null, level: 'B1', venue: { name: 'Bishan', type: 'MRT_STATION' } };
    expect(toiletTitle(t)).toBe('Bishan MRT · B1');
    expect(toiletTitle({ ...t, label: 'B1 concourse' })).toBe('Bishan MRT · B1 concourse');
  });

  it("says whose toilet it is unless the label already does", () => {
    const t = { label: 'EWL side', level: null, venue: { name: 'Outram Park', type: 'MRT_STATION' } };
    expect(toiletTitle({ ...t, sex: 'MALE' })).toBe("Outram Park MRT · EWL side · Men's");
    expect(toiletTitle({ ...t, label: "Women's, NEL side", sex: 'FEMALE' })).toBe("Outram Park MRT · Women's, NEL side");
    expect(toiletTitle({ ...t, label: 'Accessible / unisex', sex: 'UNISEX' })).toBe('Outram Park MRT · Accessible / unisex');
    expect(toiletTitle({ ...t, label: null, sex: 'UNISEX' })).toBe('Outram Park MRT · Unisex');
    expect(toiletTitle({ ...t, sex: null })).toBe('Outram Park MRT · EWL side');
    // "Women's" contains "men's": a men's toilet whose label says Women's still gets its own word.
    expect(toiletTitle({ ...t, label: "next to Women's", sex: 'MALE' })).toBe("Outram Park MRT · next to Women's · Men's");
  });

  it('shows the sex in the result card title', () => {
    const text = formatItem(item({ sex: 'UNISEX', label: null, level: null, features: ['UNISEX', 'BIDET'] }), 1, NOW);
    expect(text.split('\n')[0]).toContain('Test Mall · Unisex');
    expect(text.split('\n').at(-1)).toBe('Bidet');
  });

  it('says how long ago at day resolution', () => {
    expect(lastCheckedText(null, NOW)).toBe('never checked in person');
    expect(lastCheckedText('2026-10-20T01:00:00Z', NOW)).toBe('checked today');
    expect(lastCheckedText('2026-10-19T01:00:00Z', NOW)).toBe('checked yesterday');
    expect(lastCheckedText('2026-10-10T01:00:00Z', NOW)).toBe('checked 10 days ago');
    expect(lastCheckedText('2026-09-01T01:00:00Z', NOW)).toBe('checked 7 weeks ago');
    expect(lastCheckedText('2026-01-01T01:00:00Z', NOW)).toBe('checked 9 months ago');
  });

  it('only gives a verdict for a score', () => {
    expect(verdictWord(null)).toBeNull();
    expect(verdictWord(8)).toBe('Shiok!');
    expect(verdictWord(6.5)).toBe('Can lah');
    expect(verdictWord(3)).toBe('Aiyo');
  });
});

describe('formatResults', () => {
  const result = {
    items: [item(), item({ id: 'cmsecond00000000000000000' }), item({ id: 'cmthird000000000000000000' })],
    searchedRadiusM: 1500,
    skippedVenues: [{ name: 'Bishan CCL', toiletStatus: 'NONE', note: 'uses HDB Hub', distanceM: 200 }],
  };

  const buttonsOf = (kb: { inline_keyboard: unknown[][] }) =>
    buttons(kb as { inline_keyboard: { text: string }[][] }) as { text: string; url?: string; callback_data?: string }[];

  it('private location answer: title links, one pick button per toilet, nearest only and filters', () => {
    const { text, keyboard } = formatResults(result, opts());
    expect(text.startsWith('🚽 <b>Top 3 near you</b>')).toBe(true);
    expect(text).toContain('Nearby but no toilet: Bishan CCL (uses HDB Hub)');
    const details = `${BASE}/toilets/${ID}?utm_source=telegram&amp;utm_medium=bot&amp;utm_campaign=near`;
    expect(text).toContain(`<b>1. <a href="${details}">Test Mall · L1 near lifts</a></b>`);
    const rows = keyboard.inline_keyboard;
    expect(rows.map((r) => r.length)).toEqual([1, 1, 1, 2]);
    const b = buttonsOf(keyboard);
    expect(b.map((x) => x.text)).toEqual([
      '1. Test Mall · L1 near lifts · 3 min',
      '2. Test Mall · L1 near lifts · 3 min',
      '3. Test Mall · L1 near lifts · 3 min',
      '🚨 Nearest only',
      '🎛 Filters',
    ]);
    const minute = (29_000_000).toString(36);
    expect(b[0]!.callback_data).toBe(`p:c,${ID},1.3510,103.8480,${minute}`);
    expect(b[1]!.callback_data).toBe(`p:c,cmsecond00000000000000000,1.3510,103.8480,${minute}`);
    expect(b[3]).toMatchObject({ callback_data: 'u:1.3510,103.8480' });
    expect(b[4]).toMatchObject({ callback_data: 'f:*' });
    expect(b.some((x) => x.url)).toBe(false);
  });

  it('place search: picks carry no minute, heading names the place, station link', () => {
    const { text, keyboard } = formatResults(
      result,
      opts({ checkInMinute: undefined, placeName: 'Bishan <MRT>', stationLink: `${BASE}/stations/bishan`, campaign: 'search' }),
    );
    expect(text).toContain('<b>Toilets near Bishan &lt;MRT&gt;</b>');
    expect(text).toContain(`<a href="${BASE}/stations/bishan">Station page</a>`);
    const b = buttonsOf(keyboard);
    expect(b[0]!.callback_data).toBe(`p:c,${ID},1.3510,103.8480`);
    expect(b.some((x) => x.callback_data?.startsWith('c:'))).toBe(false);
  });

  it('falls back to a Navigate link when a pick would not fit', () => {
    const longId = 'x'.repeat(40);
    const { keyboard } = formatResults({ ...result, items: [item({ id: longId })] }, opts());
    const b = buttonsOf(keyboard);
    expect(b[0]).toMatchObject({ text: '🧭 1. Navigate ↗' });
    expect(b[0]!.url).toContain('dir_action=navigate');
    expect(b[0]!.callback_data).toBeUndefined();
  });

  it('group answer: three navigate links and Filters, no callbacks but f:*', () => {
    const { text, keyboard } = formatResults(result, opts({ group: true }));
    expect(text).toContain(`<a href="${BASE}/toilets/${ID}?`);
    const b = buttonsOf(keyboard);
    expect(b.map((x) => x.text)).toEqual([
      '🧭 1. Test Mall · L1 near lifts ↗',
      '🧭 2. Test Mall · L1 near lifts ↗',
      '🧭 3. Test Mall · L1 near lifts ↗',
      '🎛 Filters',
    ]);
    expect(b.slice(0, 3).every((x) => x.url?.includes('dir_action=navigate'))).toBe(true);
    expect(b.filter((x) => x.callback_data).map((x) => x.callback_data)).toEqual(['f:*']);
  });

  it('urgent list has no nearest-only button, keeps Filters and shows saved filters', () => {
    const { text, keyboard } = formatResults(
      result,
      opts({ urgent: true, filters: { filters: ['ACCESSIBLE'], areaType: null, openNow: false } }),
    );
    expect(text.startsWith('🚨 <b>Closest to you</b>')).toBe(true);
    expect(text).toContain('Filters: accessible (change with /filters)');
    const b = buttonsOf(keyboard);
    expect(b.some((x) => x.text.includes('Nearest only'))).toBe(false);
    expect(b.at(-1)).toMatchObject({ text: '🎛 Filters', callback_data: 'f:*' });
    expect(b[0]!.callback_data!.startsWith(`p:u,${ID},`)).toBe(true);
  });
});

describe('formatCard', () => {
  const card = (over: Partial<CardOptions> = {}, it = item()) =>
    formatCard(it, {
      appBase: BASE,
      campaign: 'near',
      urgent: false,
      origin: { lat: 1.351, lng: 103.848 },
      checkInMinute: 29_000_000,
      now: NOW,
      ...over,
    });
  const cardButtons = (kb: { inline_keyboard: unknown[][] }) =>
    kb.inline_keyboard as { text: string; url?: string; callback_data?: string }[][];
  const minute = (29_000_000).toString(36);

  it('is the list entry without the number, title linked', () => {
    const { text } = card();
    const url = `${BASE}/toilets/${ID}?utm_source=telegram&amp;utm_medium=bot&amp;utm_campaign=near`;
    expect(text).toBe(
      [
        `<b><a href="${url}">Test Mall · L1 near lifts</a></b>`,
        '3 min walk · 240 m',
        'Verified · checked 2 years ago',
        'Clean 8.2/10 (Shiok!) · survey 40/50',
        'Accessible, Bidet, Toilet paper',
      ].join('\n'),
    );
  });

  it('with Back, Navigate, Details, I\'m here and Report', () => {
    const rows = cardButtons(card().keyboard);
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([
      ['🧭 Navigate ↗', 'ℹ️ Details ↗'],
      ["✅ I'm here", '⚠️ Report'],
      ['◀ Back to list'],
    ]);
    expect(rows[0]![0]!.url).toContain('dir_action=navigate');
    expect(rows[0]![1]!.url).toBe(`${BASE}/toilets/${ID}?utm_source=telegram&utm_medium=bot&utm_campaign=near`);
    expect(rows[1]![0]!.callback_data).toBe(`c:${ID},1.3510,103.8480,${minute}`);
    expect(rows[1]![1]!.callback_data).toBe(`r:${ID}`);
    expect(rows[2]![0]!.callback_data).toBe(`l:c,1.3510,103.8480,${minute}`);
  });

  it('has no I\'m here without a fresh own-location minute, and Back carries no minute either', () => {
    const rows = cardButtons(card({ checkInMinute: undefined, urgent: true }).keyboard);
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([
      ['🧭 Navigate ↗', 'ℹ️ Details ↗'],
      ['⚠️ Report'],
      ['◀ Back to list'],
    ]);
    expect(rows[2]![0]!.callback_data).toBe('l:u,1.3510,103.8480');
  });

  it('single (urgent first answer): header, no Back, See 2 more', () => {
    const { text, keyboard } = card({ single: true, urgent: true, more: 2 });
    expect(text.startsWith('🚨 <b>Closest to you</b>\n<b><a href=')).toBe(true);
    const rows = cardButtons(keyboard);
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([
      ['🧭 Navigate ↗', 'ℹ️ Details ↗'],
      ["✅ I'm here", '⚠️ Report'],
      ['📋 See 2 more'],
    ]);
    expect(rows[2]![0]!.callback_data).toBe(`l:u,1.3510,103.8480,${minute}`);
    expect(cardButtons(card({ single: true, urgent: true, more: 1 }).keyboard).at(-1)![0]!.text).toBe('📋 See 1 more');
  });

  it('single with nothing else: no Back and no See more', () => {
    const rows = cardButtons(card({ single: true, urgent: true, more: 0 }).keyboard);
    expect(rows).toHaveLength(2);
  });

  it('names the place it searched near, escaped, and marks unconfirmed ones', () => {
    const { text } = card({ placeName: 'Bishan <MRT>' }, item({}, { unconfirmed: true }));
    expect(text.startsWith('🚽 Near Bishan &lt;MRT&gt;\n<b><a href=')).toBe(true);
    expect(text).toContain('Unconfirmed');
    expect(card({ single: true, urgent: true, placeName: 'Bishan' }).text.startsWith('🚨 <b>Closest near Bishan</b>')).toBe(true);
  });
});

describe('copy', () => {
  it('status keyboard has the seven kinds', () => {
    const b = buttons(statusKeyboard(ID)) as { text: string; callback_data?: string }[];
    expect(b.map((x) => x.text)).toEqual([
      '👍 All good',
      '🧻 No paper',
      '🧼 No soap',
      '⏳ Long queue',
      '🧹 Being cleaned',
      '🔧 Something broken',
      '🚫 Closed now',
    ]);
    expect(b[1]!.callback_data).toBe(`r:${ID},NO_PAPER`);
    expect(Object.keys(STATUS_ICONS)).toHaveLength(7);
    expect(statusKeyboard(ID).inline_keyboard.map((r) => r.length)).toEqual([2, 2, 2, 1]);
  });

  it('empty and not-found messages escape and mention filters', () => {
    expect(emptyText({ radiusKm: 3, filters: { filters: ['BIDET'], areaType: null, openNow: false }, mapLink: BASE })).toContain(
      'Your filters (bidet)',
    );
    expect(placeNotFoundText('<x>')).toContain('"&lt;x&gt;"');
  });

  it('check-in text: banked when unlinked, points when linked', () => {
    const r = { distanceM: 40, pointsAwarded: 4, bankedPoints: 4, newBadges: [], confirmedPending: false, wentLive: false };
    expect(checkInText('Test Mall', r, false)).toContain('4 points banked for this chat');
    expect(checkInText('Test Mall', r, true)).toContain('+4 points');
    expect(checkInText('Test Mall', r, true)).toContain('(40 m away)');
  });

  it('linked text names the handle and points moved', () => {
    expect(linkedText('loo_ranger', 4)).toContain('Linked as <b>@loo_ranger</b>. 4 points moved over.');
    expect(linkedText(null, 0)).not.toContain('moved');
  });

  it('tidies OneMap capitals', () => {
    expect(tidyPlaceName('BISHAN MRT STATION (NS17 / CC15)')).toBe('Bishan MRT Station (NS17 / CC15)');
    expect(tidyPlaceName('Junction 8')).toBe('Junction 8');
  });
});
