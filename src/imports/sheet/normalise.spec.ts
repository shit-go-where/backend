import { collectBlock, normaliseSheet, parseMiscStations, readScoreTable } from './normalise.js';

const HEADER: string[][] = [
  ['Type', 'Location', 'Total (50)', 'Cleanliness (10)', 'Toiletries (5)', '', 'Other Remarks'],
  ['', '', '', '', 'Toilet Paper (1)', 'Hand Towel (1)', ''],
];

describe('readScoreTable', () => {
  it('merges the two header rows and skips headings, means and ranges', () => {
    const rows = [
      ['RAS 3-Star', '', '', '', '', '', ''],
      ...HEADER,
      ['MRT', 'Boon Keng NEL', '29', '8', '1', '0', ''],
      ['Mean Values (3-Star)', '', '27.3', '6.6', '1', '0', ''],
      ['Range (3-Star)', '', '24-29', '', '', '', ''],
      ['RAS 4-Star', '', '', '', '', '', ''],
      ['HC', 'Chong Pang', '26', '6', '1', '0', 'x'],
      ['North South Line Mean Values', '', '32', '7', '1', '0', ''],
    ];
    const recs = readScoreTable(rows);
    expect(recs.map((r) => r.get('Location'))).toEqual(['Boon Keng NEL', 'Chong Pang']);
    expect(recs[0]!.section).toBe('RAS 3-Star');
    expect(recs[1]!.section).toBe('RAS 4-Star');
    expect(recs[0]!.get('Toilet Paper (1)')).toBe('1');
    expect(recs[0]!.get('Hand Towel (1)')).toBe('0');
    expect(recs[1]!.get('Other Remarks')).toBe('x');
  });
});

describe('Miscellaneous parsing', () => {
  const misc = [
    ['Toilets under Renovation', '', '', '', '', 'Date'],
    ['Bukit Batok', 'Tampines EWL', '', '', '', 'Wed'],
    ['Pioneer', '', '', '', '', 'Wed'],
    ['', '', '', '', '', 'Sat'],
    ['Stations without Toilets', '', '', '', '', 'Sun'],
    ['Expo EWL', '', '', '', '', ''],
    ['Bishan CCL', '', '', '', '', ''],
    ['Toa Payoh NSL (Uses HDB Hub toilets)', '', '', '', '', ''],
    ['Tiong Bahru, Bugis, Lavender EWL (Handicapped Only)', '', '', '', '', ''],
  ];
  it('collects the renovation block from the first columns only', () => {
    expect(collectBlock(misc, /^toilets under renovation$/i, 4)).toEqual(['Bukit Batok', 'Tampines EWL', 'Pioneer']);
  });
  it('classifies no-toilet, uses-nearby and handicapped-only stations', () => {
    const m = parseMiscStations(misc);
    expect(m.noToilet.map((p) => `${p.name}/${p.lines}`)).toEqual(['Expo/EWL', 'Bishan/CCL']);
    expect(m.usesNearby).toEqual([expect.objectContaining({ note: 'Uses HDB Hub toilets' })]);
    expect(m.usesNearby[0]!.parsed.name).toBe('Toa Payoh');
    expect(m.handicappedOnly.map((p) => `${p.name}/${p.lines}`)).toEqual(['Tiong Bahru/EWL', 'Bugis/EWL', 'Lavender/EWL']);
  });
});

describe('normaliseSheet (committed raw CSVs)', () => {
  const { fieldwork, review } = normaliseSheet();
  const surveyed = fieldwork.toilets.filter((t) => t.surveys.length);

  it('imports all 160 fieldwork toilets with the right mix', () => {
    expect(surveyed).toHaveLength(160);
    const byType: Record<string, number> = {};
    for (const t of surveyed) {
      const v = fieldwork.venues.find((x) => x.key === t.venueKey)!;
      byType[v.type] = (byType[v.type] ?? 0) + 1;
    }
    expect(byType).toEqual({ MRT_STATION: 139, MALL: 11, BUS_INTERCHANGE: 3, COFFEESHOP: 3, HAWKER_CENTRE: 3, COMMUNITY_CLUB: 1 });
  });

  it('has unique source keys and venue keys', () => {
    expect(new Set(fieldwork.toilets.map((t) => t.sourceKey)).size).toBe(fieldwork.toilets.length);
    expect(new Set(fieldwork.venues.map((v) => v.sourceKey)).size).toBe(fieldwork.venues.length);
  });

  it('groups interchanges into one venue', () => {
    const op = fieldwork.toilets.filter((t) => t.venueKey === 'mrt-outram-park');
    expect(op.map((t) => t.label).sort()).toEqual(['EWL side', 'NEL side', 'TEL side']);
    expect(fieldwork.venues.find((v) => v.key === 'mrt-outram-park')!.lines).toEqual(['EWL', 'NEL', 'TEL']);
  });

  it('keeps RAS 6 out of the data and in review.json; 28 unrated', () => {
    const mbs = fieldwork.toilets.find((t) => t.sourceKey === 'sheet:marina-bay-sands')!;
    expect(mbs.surveys[0]!.rasStars).toBeNull();
    expect(review.some((r) => r.kind === 'ras-out-of-range' && r.key === 'sheet:marina-bay-sands')).toBe(true);
    expect(surveyed.filter((t) => t.surveys[0]!.rasStars === null)).toHaveLength(29); // 28 blanks + the 6
  });

  it('records no-toilet / uses-nearby stations', () => {
    const v = (k: string) => fieldwork.venues.find((x) => x.key === k)!;
    expect(v('mrt-changi-airport').toiletStatus).toBe('NONE');
    expect(v('mrt-toa-payoh').toiletStatus).toBe('USES_NEARBY');
    expect(v('mrt-toa-payoh').usesNearbyVenueKey).toBe('mall-hdb-hub-toa-payoh');
    expect(v('mrt-bishan').toiletStatus).toBe('HAS_TOILETS');
    expect(v('mrt-bishan').note).toMatch(/CCL/);
  });

  it('flags renewal stations and adds pre-renewal surveys', () => {
    const t = (k: string) => fieldwork.toilets.find((x) => x.sourceKey === k)!;
    expect(t('sheet:bukit-batok')).toMatchObject({ status: 'RENOVATION', needsResurvey: true, surveys: [] });
    expect(t('sheet:tampines-ewl').venueKey).toBe('mrt-tampines');
    expect(t('sheet:jurong-east-nsl-ewl').surveys.map((s) => s.phase)).toEqual([null, 'pre-renewal']);
    expect(t('sheet:clementi-ewl').surveys.map((s) => s.phase)).toEqual(['post-renewal']);
  });

  it('turns the handicapped-only remark into features', () => {
    const t = fieldwork.toilets.find((x) => x.sourceKey === 'sheet:tiong-bahru-ewl')!;
    const f = Object.fromEntries(t.features.map((x) => [x.feature, x.present]));
    expect(f).toMatchObject({ MALE: false, FEMALE: false, ACCESSIBLE: true, UNISEX: true, FREE: true, SITTING: true });
    expect(t.surveys.map((s) => s.sex)).toEqual(['UNISEX']);
  });

  it("tags the surveyed men's toilets MALE; renovation placeholders stay unknown", () => {
    const sexOf = (t: (typeof fieldwork.toilets)[number]) => {
      const f = Object.fromEntries(t.features.map((x) => [x.feature, x.present]));
      return f['UNISEX'] ? 'UNISEX' : f['MALE'] ? 'MALE' : null;
    };
    const counts: Record<string, number> = {};
    for (const t of surveyed) counts[String(sexOf(t))] = (counts[String(sexOf(t))] ?? 0) + 1;
    expect(counts).toEqual({ MALE: 157, UNISEX: 3 });
    expect(sexOf(fieldwork.toilets.find((x) => x.sourceKey === 'sheet:bukit-batok')!)).toBeNull();
  });

  it('writes every survey as PILOT_50 with no breakdown', () => {
    const all = fieldwork.toilets.flatMap((t) => t.surveys);
    expect(all).toHaveLength(166);
    expect(all.every((s) => s.rubric === 'PILOT_50' && s.breakdown === null && s.total !== null)).toBe(true);
    expect(all.filter((s) => s.sex === 'MALE')).toHaveLength(163);
  });
});
