import { accessOf, chooseVenue, featuresFromTags, findDuplicate, levelOf, openingHoursOf, venueTypeFromTags } from './tags.js';

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
    expect(levelOf({ level: '-1' })).toBe('-1');
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
