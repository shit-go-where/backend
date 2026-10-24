import { ExpandedBreakdownSchema, normaliseExpandedCleanliness } from '../../toilets/survey-items.js';
import { normaliseSurvey2, toiletSuffixes } from './normalise.js';
import { stripRetraction } from './parse.js';

const HEADER = [
  'Timestamp',
  'Sector',
  'Sex of the toilet that you are surveying',
  'Location Code (for MRTs, indicate station code)',
  'If the toilet ... describe the location of the toilet.',
  'Cleanliness [Cleanliness]',
  'State briefly why you gave such a rating',
  'Scent [Scent]',
  'Toiletries',
  'Facilities and Maintenance',
  'Photos?',
];
const INDEX = [
  ['Location Code', 'Address', 'Premise Name', 'Planning Area', 'Planning Subzone', 'Management & Maintenance Operator'],
  ['NE3', '', 'Outram Park NEL', '', '', ''],
  ['EW16', '', 'Outram Park EWL', '', '', ''],
  ['TE17', '', 'Outram Park TEL', '', '', ''],
  ['M6', '1 PASIR RIS CENTRAL STREET 3 Singapore ', 'White Sands', '', '', ''],
  ['C28', '101 YISHUN AVENUE 5 #01-93, S(760101)', '', '', '', ''],
  ['C29', '101 YISHUN AVENUE 5 #01-101, S(760101)', '', '', '', ''],
  ['H85', 'Blk 79, Redhill Lane, S(150079)', 'Blk 79 Redhill Lane', '', '', 'NEA'],
];
const REASONS_ALL =
  'General appearance of toilet looks stain-free. (floor, walls, wall tiles, ceiling, cubicle doors), Floor is free of litter/little presence of litter';
const row = (over: Partial<Record<'ts' | 'sex' | 'code' | 'loc' | 'clean' | 'reasons' | 'scent' | 'toiletries' | 'facilities' | 'photo', string>>) => [
  over.ts ?? '24/08/2024 09:15:35',
  'Sector',
  over.sex ?? 'Female',
  over.code ?? 'NE3',
  over.loc ?? '',
  over.clean ?? '2',
  over.reasons ?? REASONS_ALL,
  over.scent ?? '0',
  over.toiletries ?? 'Toilet Paper, Hand Soap',
  over.facilities ?? 'Mirrors functional, Taps functional, Handicapped Facilities Available',
  over.photo ?? '',
];

describe('normaliseSurvey2', () => {
  const raw = [
    HEADER,
    row({ ts: '12/10/2024 13:44:26', sex: 'Female', code: 'NE3', reasons: `${REASONS_ALL}, [Female] Sanitary bin is clean, intact and lined with plastic bag.`, photo: 'https://drive.google.com/open?id=1AeW822oPhOPkYOBj9arP2-KcPnqx_HQr' }),
    row({ ts: '12/10/2024 13:34:14', sex: 'Male', code: 'TE17', clean: '-3', scent: '-2', toiletries: 'None of the Above', facilities: 'None of the Above' }),
    row({ ts: '13/10/2024 16:19:00', sex: 'Male', code: 'M6.', loc: '' }),
    row({ ts: '13/10/2024 16:24:00', sex: 'Male', code: 'M6', loc: 'Level 5' }),
    row({ ts: '13/10/2024 16:31:00', sex: 'Female', code: 'M6', loc: 'Level B1' }),
    row({ ts: '13/10/2024 16:32:00', sex: 'Female', code: 'M6', loc: 'Level B1' }),
    row({ ts: '24/08/2024 09:23:29', sex: 'Female', code: 'H85', reasons: 'Toilets are free of chokage., There does not appear to be a sanitary bin' }),
    row({ ts: '24/08/2024 09:24:20', sex: 'Unisex (incl. Handicapped)', code: 'C28' }),
    row({ ts: '24/08/2024 09:25:20', sex: 'Male', code: 'C29' }),
    row({ ts: 'not a date', code: 'C29' }),
  ];
  const { fieldwork, review, stats } = normaliseSurvey2(raw, INDEX);
  const toilet = (k: string) => fieldwork.toilets.find((t) => t.sourceKey === k)!;
  const feature = (k: string, f: string) => toilet(k).features.find((x) => x.feature === f)?.present;

  it('makes one toilet per (code, sex) and one venue per code', () => {
    expect(fieldwork.venues.map((v) => v.key)).toEqual(['C28', 'C29', 'H85', 'M6', 'NE3', 'TE17']);
    expect(fieldwork.toilets.map((t) => t.sourceKey)).toEqual([
      'survey2:C28/unisex',
      'survey2:C29/male',
      'survey2:H85/female',
      'survey2:M6/female/b1-1',
      'survey2:M6/female/b1-2',
      'survey2:M6/male/1',
      'survey2:M6/male/l5',
      'survey2:NE3/female',
      'survey2:TE17/male',
    ]);
    expect(stats['surveys']).toBe(9);
  });

  it('writes the expanded rubric exactly as the contract says', () => {
    const s = toilet('survey2:NE3/female').surveys[0]!;
    expect(s).toMatchObject({ rubric: 'EXPANDED_2024', sex: 'FEMALE', surveyedAt: '2024-10-12T13:44:26+08:00', cleanliness: normaliseExpandedCleanliness(2), total: null, scent: null });
    expect(ExpandedBreakdownSchema.parse(s.breakdown)).toEqual({
      cleanliness: 2,
      scent: 0,
      reasons: [
        'General appearance of toilet looks stain-free. (floor, walls, wall tiles, ceiling, cubicle doors)',
        'Floor is free of litter/little presence of litter',
        '[Female] Sanitary bin is clean, intact and lined with plastic bag.',
      ],
      toiletries: ['Toilet Paper', 'Hand Soap'],
      facilities: ['Mirrors functional', 'Taps functional', 'Handicapped Facilities Available'],
    });
    const m = toilet('survey2:TE17/male').surveys[0]!;
    expect(m.breakdown).toMatchObject({ cleanliness: -3, scent: -2, toiletries: [], facilities: [] });
    expect(m.cleanliness).toBe(0);
    expect(toilet('survey2:H85/female').surveys[0]!.remarks).toBe('There does not appear to be a sanitary bin');
  });

  it('maps checklists to presence features, sex features and the sanitary bin', () => {
    expect(feature('survey2:NE3/female', 'TOILET_PAPER')).toBe(true);
    expect(feature('survey2:NE3/female', 'HAND_DRYER')).toBe(false);
    expect(feature('survey2:NE3/female', 'MIRROR')).toBe(true);
    expect(feature('survey2:NE3/female', 'ACCESSIBLE')).toBe(true);
    expect(feature('survey2:NE3/female', 'SANITARY_BIN')).toBe(true);
    expect(feature('survey2:NE3/female', 'FEMALE')).toBe(true);
    expect(feature('survey2:NE3/female', 'MALE')).toBe(false);
    // "Taps functional" is state, not a feature.
    expect(toilet('survey2:NE3/female').features.some((f) => f.feature === ('TAPS' as string))).toBe(false);
    // Not ticked and a remark says there is none -> absent; not ticked, nothing said -> unknown.
    expect(feature('survey2:H85/female', 'SANITARY_BIN')).toBe(false);
    expect(feature('survey2:TE17/male', 'SANITARY_BIN')).toBeUndefined();
    expect(feature('survey2:C28/unisex', 'UNISEX')).toBe(true);
    expect(feature('survey2:C28/unisex', 'MALE')).toBe(false);
    expect(feature('survey2:C28/unisex', 'FEMALE')).toBe(false);
  });

  it('labels, levels and line sides', () => {
    expect(toilet('survey2:NE3/female')).toMatchObject({ label: "Women's, NEL side", lines: ['NEL'], level: null, lastVerifiedAt: '2024-10-12T13:44:26+08:00' });
    expect(toilet('survey2:M6/male/l5')).toMatchObject({ label: "Men's", level: 'L5', accessNote: null });
    expect(toilet('survey2:C28/unisex').label).toBe('Accessible / unisex');
    const outram = fieldwork.venues.find((v) => v.key === 'NE3')!;
    expect(outram).toMatchObject({ name: 'Outram Park', type: 'MRT_STATION', lines: ['EWL', 'NEL', 'TEL'], geocode: { strategy: 'mrt' } });
  });

  it('names coffeeshops by address and tells apart two in one block', () => {
    expect(fieldwork.venues.find((v) => v.key === 'C28')).toMatchObject({
      name: 'Coffeeshop, Blk 101 Yishun Avenue 5 (#01-93)',
      postalCode: '760101',
      geocode: { strategy: 'postal', query: '760101' },
    });
    expect(fieldwork.venues.find((v) => v.key === 'H85')).toMatchObject({ type: 'HAWKER_CENTRE', address: '79 Redhill Lane, Singapore 150079' });
  });

  it('lists everything it decided in review.json', () => {
    const kinds = review.map((r) => r.kind).sort();
    expect(kinds).toEqual(['survey2-code-fixed', 'survey2-name-collision', 'survey2-row-skipped', 'survey2-same-sex-ordinal', 'survey2-same-sex-ordinal']);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(normaliseSurvey2(raw, INDEX).fieldwork)).toBe(JSON.stringify(fieldwork));
  });
});

describe('toiletSuffixes', () => {
  const g = (...levels: (string | null)[]) => levels.map((level) => ({ loc: { level } }));
  it('keys several toilets of one sex by level, else by ordinal', () => {
    expect(toiletSuffixes(g(null))).toEqual([null]);
    expect(toiletSuffixes(g('L1', 'L3', 'B1'))).toEqual(['l1', 'l3', 'b1']);
    expect(toiletSuffixes(g('B1', 'B1', 'L1'))).toEqual(['b1-1', 'b1-2', 'l1']);
    expect(toiletSuffixes(g(null, null, 'L2'))).toEqual(['1', '2', 'l2']);
  });
});

describe('retractions and remarks', () => {
  const OOPS = '(ignore previous response pls sorry)';
  const REASONS_NOTE = 'Toilets are free of chokage., Smells of durian';
  const raw = [
    HEADER,
    // Taken back by the next row: same code, sex and team, 3 minutes later.
    row({ ts: '24/08/2024 09:30:00', sex: 'Female', code: 'H85', clean: '-3' }),
    row({ ts: '24/08/2024 09:33:00', sex: 'Female', code: 'H85', loc: OOPS, clean: '1' }),
    // No earlier row of this sex: both kept, flagged.
    row({ ts: '24/08/2024 09:20:00', sex: 'Male', code: 'C28' }),
    row({ ts: '24/08/2024 09:25:00', sex: 'Female', code: 'C28', loc: OOPS }),
    row({ ts: '24/08/2024 09:40:00', sex: 'Male', code: 'C29', reasons: REASONS_NOTE }),
    row({ ts: '24/08/2024 09:41:00', sex: 'Female', code: 'C29', reasons: `${REASONS_NOTE} and tissue everywhere` }),
  ];
  const c29m = 'survey2:C29/male#2024-08-24T09:40:00+08:00';
  const c29f = 'survey2:C29/female#2024-08-24T09:41:00+08:00';
  const { fieldwork, review, remarks } = normaliseSurvey2(raw, INDEX, { [c29m]: null, [c29f]: 'Smells of durian', 'survey2:nope#x': 'x' });
  const toilet = (k: string) => fieldwork.toilets.find((t) => t.sourceKey === k)!;

  it('drops the row a retraction takes back when it is the only candidate, and hides the note', () => {
    expect(toilet('survey2:H85/female').surveys.map((s) => s.surveyedAt)).toEqual(['2024-08-24T09:33:00+08:00']);
    expect(toilet('survey2:H85/female')).toMatchObject({ accessNote: null, level: null });
    const items = review.filter((r) => r.kind === 'survey2-retraction');
    expect(items).toHaveLength(2);
    expect(items[0]!.resolution).toBe('auto: row 2 not imported; row 3 imported without the note');
    expect(items[1]!.message).toContain('No earlier FEMALE row');
    expect(toilet('survey2:C28/female').surveys).toHaveLength(1);
    expect(toilet('survey2:C28/male').surveys).toHaveLength(1);
  });

  it('applies remarkOverrides and lists every remark', () => {
    expect(toilet('survey2:C29/male').surveys[0]!.remarks).toBeNull();
    expect(toilet('survey2:C29/female').surveys[0]!.remarks).toBe('Smells of durian');
    expect(remarks).toEqual([
      { key: c29f, toilet: 'survey2:C29/female', venue: 'Coffeeshop, Blk 101 Yishun Avenue 5 (#01-101)', sex: 'FEMALE', remark: 'Smells of durian', original: 'Smells of durian and tissue everywhere' },
      { key: c29m, toilet: 'survey2:C29/male', venue: 'Coffeeshop, Blk 101 Yishun Avenue 5 (#01-101)', sex: 'MALE', remark: null, original: 'Smells of durian' },
    ]);
    expect(review.filter((r) => r.kind === 'survey2-remark-override-orphan').map((r) => r.key)).toEqual(['survey2:nope#x']);
  });
});

describe('stripRetraction', () => {
  it('removes the note and its brackets', () => {
    expect(stripRetraction('(ignore previous response pls sorry)')).toBe('');
    expect(stripRetraction('Level 2 (ignore previous response pls sorry)')).toBe('Level 2');
  });
});
