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
  formatItem,
  formatResults,
  lastCheckedText,
  linkedText,
  placeNotFoundText,
  statusKeyboard,
  tidyPlaceName,
  toggleFilter,
  toiletTitle,
  verdictWord,
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
      'u:91.0000,103.8',
    ]) {
      expect(decodeCallback(bad)).toBeNull();
    }
  });

  it('refuses ids that would not fit', () => {
    expect(encodeCallback({ kind: 'checkin', toiletId: 'x'.repeat(41), lat: 1.35, lng: 103.84, minute: 29_345_678 })).toBeNull();
    expect(encodeCallback({ kind: 'report', toiletId: 'has space' })).toBeNull();
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

  it('titles MRT venues and skips a level the label already says', () => {
    const t = { label: null, level: 'B1', venue: { name: 'Bishan', type: 'MRT_STATION' } };
    expect(toiletTitle(t)).toBe('Bishan MRT · B1');
    expect(toiletTitle({ ...t, label: 'B1 concourse' })).toBe('Bishan MRT · B1 concourse');
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

  it('private location answer: navigate, details, check in, report, closest only', () => {
    const { text, keyboard } = formatResults(result, opts());
    expect(text.startsWith('🚽 <b>Top 3 near you</b>')).toBe(true);
    expect(text).toContain('Nearby but no toilet: Bishan CCL (uses HDB Hub)');
    const b = buttons(keyboard) as { text: string; url?: string; callback_data?: string }[];
    expect(b.map((x) => x.text).slice(0, 4)).toEqual(['1. Navigate', '1. Details', "1. I'm here, check in", '1. Report']);
    expect(b[0]!.url).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=1.3519%2C103.8481&travelmode=walking&dir_action=navigate',
    );
    expect(b[1]!.url).toBe(`${BASE}/toilets/${ID}?utm_source=telegram&utm_medium=bot&utm_campaign=near`);
    expect(b[2]!.callback_data).toBe(`c:${ID},1.3510,103.8480,${(29_000_000).toString(36)}`);
    expect(b[3]!.callback_data).toBe(`r:${ID}`);
    expect(b.at(-1)).toMatchObject({ text: '🚨 Closest only', callback_data: 'u:1.3510,103.8480' });
    expect(b).toHaveLength(13);
  });

  it('place search: no check-in, heading names the place, station link', () => {
    const { text, keyboard } = formatResults(
      result,
      opts({ checkInMinute: undefined, placeName: 'Bishan <MRT>', stationLink: `${BASE}/stations/bishan`, campaign: 'search' }),
    );
    expect(text).toContain('<b>Toilets near Bishan &lt;MRT&gt;</b>');
    expect(text).toContain(`<a href="${BASE}/stations/bishan">Station page</a>`);
    const labels = buttons(keyboard).map((x) => x.text);
    expect(labels.some((l) => l.includes("I'm here"))).toBe(false);
    expect(labels).toContain('1. Report');
  });

  it('group answer: details and navigate only', () => {
    const { keyboard } = formatResults(result, opts({ group: true }));
    expect(buttons(keyboard).map((x) => x.text)).toEqual([
      '1. Navigate',
      '1. Details',
      '2. Navigate',
      '2. Details',
      '3. Navigate',
      '3. Details',
    ]);
  });

  it('urgent answer has no closest-only button and shows saved filters', () => {
    const { text, keyboard } = formatResults(
      result,
      opts({ urgent: true, filters: { filters: ['ACCESSIBLE'], areaType: null, openNow: false } }),
    );
    expect(text.startsWith('🚨 <b>Closest to you</b>')).toBe(true);
    expect(text).toContain('Filters: accessible (change with /filters)');
    expect(buttons(keyboard).some((x) => x.text.includes('Closest only'))).toBe(false);
  });
});

describe('copy', () => {
  it('status keyboard has the seven kinds', () => {
    const b = buttons(statusKeyboard(ID)) as { text: string; callback_data?: string }[];
    expect(b.map((x) => x.text)).toEqual([
      'All good',
      'No paper',
      'No soap',
      'Long queue',
      'Being cleaned',
      'Something broken',
      'Closed now',
    ]);
    expect(b[1]!.callback_data).toBe(`r:${ID},NO_PAPER`);
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
