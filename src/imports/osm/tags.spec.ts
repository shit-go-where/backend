import {
  accessOf,
  chooseVenue,
  featuresFromTags,
  findDuplicate,
  findNearSurveyed,
  isGenericToiletVenue,
  levelOf,
  openingHoursOf,
  osmSexes,
  survey2SexOf,
  venueTypeFromTags,
  type SurveyedToilet,
} from './tags.js';
import { levelFields } from '../../common/level.js';

describe('featuresFromTags', () => {
  it('maps the documented tags', () => {
    expect(
      featuresFromTags({
        amenity: 'toilets',
        wheelchair: 'designated',
        fee: 'no',
        changing_table: 'yes',
        'toilets:position': 'seated;urinal',
        male: 'yes',
        female: 'no',
        unisex: 'yes',
        shower: 'hot',
        'toilets:paper_supplied': 'yes',
      }),
    ).toEqual({
      ACCESSIBLE: true,
      FREE: true,
      BABY_CHANGE: true,
      SITTING: true,
      MALE: true,
      FEMALE: false,
      UNISEX: true,
      SHOWER: true,
      TOILET_PAPER: true,
    });
  });
  it('fee=yes means not free; squat position; wheelchair=no', () => {
    expect(featuresFromTags({ fee: 'yes', 'toilets:position': 'squat', wheelchair: 'no' })).toEqual({ FREE: false, SQUAT: true, ACCESSIBLE: false });
  });
  it('does not infer soap from toilets:handwashing alone', () => {
    expect(featuresFromTags({ 'toilets:handwashing': 'yes' })).toEqual({});
    expect(featuresFromTags({ 'toilets:handwashing': 'yes', soap: 'yes' })).toEqual({ HAND_SOAP: true });
  });
  it('ignores wheelchair=limited', () => {
    expect(featuresFromTags({ wheelchair: 'limited' })).toEqual({});
  });
  it('period products (limited counts) and drinking water', () => {
    expect(featuresFromTags({ 'toilets:menstrual_products': 'limited', drinking_water: 'yes' })).toEqual({
      PERIOD_PRODUCTS: true,
      WATER_REFILL: true,
    });
    expect(featuresFromTags({ 'toilets:menstrual_products': 'no', drinking_water: 'no' })).toEqual({
      PERIOD_PRODUCTS: false,
      WATER_REFILL: false,
    });
  });
});

describe('access / hours / level / venue type', () => {
  it('skips private, notes customers', () => {
    expect(accessOf({ amenity: 'toilets', access: 'private' }).skip).toBe(true);
    expect(accessOf({ amenity: 'toilets', access: 'customers' })).toEqual({ skip: false, note: 'Customers only' });
    expect(accessOf({ amenity: 'restaurant', toilets: 'yes', 'toilets:access': 'customers', access: 'yes' }).note).toBe('Customers only');
  });
  it('opening hours', () => {
    expect(openingHoursOf({ opening_hours: '24/7' })).toEqual({ type: 'always' });
    expect(openingHoursOf({ opening_hours: 'Mo-Fr 08:00-20:00' })).toEqual({ type: 'osm', value: 'Mo-Fr 08:00-20:00' });
    expect(openingHoursOf({})).toBeNull();
  });
  it('level prefers level:ref', () => {
    expect(levelOf({ level: '0', 'level:ref': 'L1' })).toBe('L1');
    expect(levelOf({ level: '-1' })).toBe('B1');
  });
  it('OSM numeric levels count the ground floor as 0', () => {
    expect(levelOf({ level: '0' })).toBe('L1');
    expect(levelOf({ level: '2' })).toBe('L3');
    expect(levelOf({ level: '-2' })).toBe('B2');
    expect(levelOf({})).toBeNull();
  });
  it('OSM multi-level values convert every floor', () => {
    expect(levelOf({ level: '0;1' })).toBe('L1; L2');
    expect(levelOf({ level: '1;2' })).toBe('L2; L3');
    expect(levelOf({ level: '1;2;3' })).toBe('L2; L3; L4');
    expect(levelOf({ level: '-1;0;1' })).toBe('B1; L1; L2');
    expect(levelOf({ level: ' -2 ; 0 ' })).toBe('B2; L1');
    // Through the normaliser as the importer writes it: no floor lost, lowest first for ordering.
    expect(levelFields(levelOf({ level: '0;1' }))).toEqual({ level: 'L1; L2', levelOrder: 1 });
    expect(levelFields(levelOf({ level: '-1;0;1' }))).toEqual({ level: 'B1; L1; L2', levelOrder: -1 });
  });
  it('non-numeric OSM levels are left for the normaliser', () => {
    expect(levelOf({ level: 'roof' })).toBe('roof');
    expect(levelOf({ level: '0;roof' })).toBe('L1; roof');
  });
  it('venue type from tags', () => {
    expect(venueTypeFromTags({ shop: 'mall' })).toBe('MALL');
    expect(venueTypeFromTags({ amenity: 'library' })).toBe('LIBRARY');
    expect(venueTypeFromTags({ railway: 'station', station: 'subway' })).toBe('MRT_STATION');
    expect(venueTypeFromTags({ amenity: 'restaurant' })).toBe('OTHER');
  });
});

describe('chooseVenue', () => {
  const p = { lat: 1.3, lng: 103.8 };
  const v = (id: string, name: string, toiletStatus = 'HAS_TOILETS') => ({ id, name, lat: 1.3, lng: 103.8, toiletStatus });
  it('prefers a similarly named venue, else the nearest', () => {
    const cands = [
      { item: v('a', 'Public toilet'), distanceM: 10 },
      { item: v('b', 'Suntec City'), distanceM: 50 },
    ];
    expect(chooseVenue(p, 'Suntec City Mall', cands)!.id).toBe('b');
    expect(chooseVenue(p, undefined, cands)!.id).toBe('a');
  });
  it('never attaches to NONE / USES_NEARBY venues or beyond the radius', () => {
    expect(chooseVenue(p, undefined, [{ item: v('x', 'Changi Airport', 'NONE'), distanceM: 5 }])).toBeNull();
    expect(chooseVenue(p, undefined, [{ item: v('y', 'Novena', 'USES_NEARBY'), distanceM: 5 }])).toBeNull();
    expect(chooseVenue(p, undefined, [{ item: v('z', 'Far'), distanceM: 61 }])).toBeNull();
  });
  it('can require a name match (toilets=yes on a shop)', () => {
    expect(chooseVenue(p, 'Ikea', [{ item: v('a', 'Public toilet'), distanceM: 5 }], 60, true)).toBeNull();
  });
});

describe('findDuplicate (dedupe rule)', () => {
  const toilets = [
    { id: '1', sourceKey: 'sheet:bugis-ewl', venueId: 'V', source: 'FIELDWORK_2024', lat: 1.3, lng: 103.8 },
    { id: '2', sourceKey: 'osm:node/1', venueId: 'V', source: 'OSM', lat: 1.3, lng: 103.8 },
    { id: '3', sourceKey: 'c:1', venueId: 'W', source: 'COMMUNITY', lat: 1.3, lng: 103.8 },
  ];
  it('skips when a fieldwork/community toilet at the same venue is within 40 m', () => {
    expect(findDuplicate({ lat: 1.3002, lng: 103.8 }, 'V', toilets)?.id).toBe('1'); // ~22 m
    expect(findDuplicate({ lat: 1.3, lng: 103.8 }, 'W', toilets)?.id).toBe('3');
  });
  it('does not skip beyond 40 m, at another venue, or against OSM toilets', () => {
    expect(findDuplicate({ lat: 1.3005, lng: 103.8 }, 'V', toilets)).toBeNull(); // ~56 m
    expect(findDuplicate({ lat: 1.3, lng: 103.8 }, 'X', toilets)).toBeNull();
    expect(findDuplicate({ lat: 1.3, lng: 103.8 }, 'V', toilets.slice(1, 2))).toBeNull();
  });
});

describe('isGenericToiletVenue', () => {
  const v = (name: string, type: string, externalIds: unknown, source = 'OSM') => ({ name, type, externalIds, source });
  it('is a generic toilet block, or a toilet node that inherited a shop name', () => {
    expect(isGenericToiletVenue(v('Public toilet', 'OTHER', { osm: 'node/1', osmKind: 'toilet' }))).toBe(true);
    expect(isGenericToiletVenue(v('Gourmet Express', 'OTHER', { osm: 'node/2', osmKind: 'feature' }))).toBe(true);
    expect(isGenericToiletVenue(v('Don Don Donki', 'MALL', { osm: 'node/3', osmKind: 'feature' }))).toBe(true);
  });
  it('is not a place of its own: claimed by data.gov.sg, typed, named like one, or not from OSM', () => {
    expect(isGenericToiletVenue(v('Senja-Cashew Community Club', 'COMMUNITY_CLUB', { osmKind: 'toilet', datagov: { cc: ['x'] } }))).toBe(false);
    expect(isGenericToiletVenue(v('Public toilet', 'OTHER', { osmKind: 'toilet', datagov: { hawker: ['x'] } }))).toBe(false);
    expect(isGenericToiletVenue(v('Jurong Regional Library', 'OTHER', { osmKind: 'feature' }))).toBe(false);
    expect(isGenericToiletVenue(v('Chinatown MRT Station', 'OTHER', { osmKind: 'feature' }))).toBe(false);
    expect(isGenericToiletVenue(v('Bishan Community Centre', 'OTHER', { osmKind: 'feature' }))).toBe(false);
    expect(isGenericToiletVenue(v('Some Hawker', 'HAWKER_CENTRE', { osmKind: 'feature' }))).toBe(false);
    expect(isGenericToiletVenue(v('Causeway Point', 'MALL', { survey2Codes: ['M11'] }, 'FIELDWORK_2024_EXPANDED'))).toBe(false);
    expect(isGenericToiletVenue(v('Public toilet', 'OTHER', null))).toBe(false);
  });
});

describe('osmSexes / survey2SexOf', () => {
  it('reads the sex tags and the survey2 key', () => {
    expect(osmSexes(featuresFromTags({ amenity: 'toilets', female: 'yes', male: 'no' }))).toEqual(['FEMALE']);
    expect(osmSexes(featuresFromTags({ amenity: 'toilets', unisex: 'yes', wheelchair: 'yes' }))).toEqual(['UNISEX']);
    expect(osmSexes(featuresFromTags({ amenity: 'toilets' }))).toEqual([]);
    expect(survey2SexOf('survey2:M11/female/b1')).toBe('FEMALE');
    expect(survey2SexOf('survey2:NE3/male')).toBe('MALE');
    expect(survey2SexOf('survey2:M18/unisex/l2')).toBe('UNISEX');
    expect(survey2SexOf('sheet:outram-park-ewl')).toBeNull();
  });
});

describe('findNearSurveyed (dedupe across venues)', () => {
  // 0.0001 deg of latitude is ~11 m.
  const s = (sourceKey: string, lat: number, extra: Partial<SurveyedToilet> = {}): SurveyedToilet => ({
    id: sourceKey,
    sourceKey,
    venueId: 'cs',
    source: 'FIELDWORK_2024_EXPANDED',
    lat,
    lng: 103.8,
    level: null,
    sex: survey2SexOf(sourceKey),
    placed: false,
    ...extra,
  });
  const at = (lat: number, level: string | null = null, sexes: ('MALE' | 'FEMALE' | 'UNISEX')[] = []) => ({ lat, lng: 103.8, level, sexes });
  it('a generic OSM toilet within 15 m of a survey2 toilet at any venue is that toilet', () => {
    const hit = findNearSurveyed(at(1.3001), true, [s('survey2:C1/male', 1.3), s('survey2:C1/female', 1.30005)]);
    expect([hit?.toilet.sourceKey, hit?.rule]).toEqual(['survey2:C1/female', 'near-15m']);
    expect(findNearSurveyed(at(1.3002), true, [s('survey2:C1/male', 1.3)])).toBeNull(); // ~22 m
  });
  it('a place of its own is only deduped by a survey2 toilet sitting on its coordinates (merged)', () => {
    expect(findNearSurveyed(at(1.3001), false, [s('survey2:C1/male', 1.3)])).toBeNull();
    const hit = findNearSurveyed(at(1.3), false, [s('survey2:M11/female/b1', 1.3, { placed: true, level: 'B1', venueId: 'mall' })]);
    expect([hit?.toilet.sourceKey, hit?.rule]).toEqual(['survey2:M11/female/b1', 'merged']);
  });
  it('needs a sex the OSM toilet is tagged for, and the same level as a survey2 toilet with its own position', () => {
    expect(findNearSurveyed(at(1.3001, null, ['FEMALE']), true, [s('survey2:C1/male', 1.3)])).toBeNull();
    expect(findNearSurveyed(at(1.3001, 'L1'), true, [s('survey2:M1/male/b1', 1.3, { level: 'B1', placed: true })])).toBeNull();
    // At the venue's point a survey2 toilet's position says nothing about the floor: the level does not matter.
    expect(findNearSurveyed(at(1.3001, 'B2'), true, [s('survey2:M1/male/l2', 1.3, { level: 'L2' })])?.rule).toBe('near-15m');
  });
  it('ignores other sources', () => {
    expect(findNearSurveyed(at(1.3), true, [s('sheet:x', 1.3, { source: 'FIELDWORK_2024' })])).toBeNull();
  });
});
