import type { Fieldwork, Fieldwork2024b, Survey2Toilet, Survey2Venue } from '../curated/schema.js';
import { hawkerPoints, matchSurvey2, osmVenues, sameName, type MatchInputs } from './match.js';

const pilotVenue = (key: string, name: string, type: string, lines: string[] = []) => ({
  key,
  sourceKey: `sheet-venue:${key}`,
  name,
  type,
  lines,
  toiletStatus: 'HAS_TOILETS',
  note: null,
  openingHours: null,
  geocode: { strategy: 'place', query: name },
  usesNearbyVenueKey: null,
});
const pilotToilet = (sourceKey: string, venueKey: string, lines: string[], opts: { level?: string; unisex?: boolean } = {}) => ({
  sourceKey,
  venueKey,
  location: sourceKey,
  label: null,
  level: opts.level ?? null,
  lines,
  status: 'ACTIVE',
  tier: 'VERIFIED',
  areaType: 'UNKNOWN',
  lastVerifiedAt: '2024-03-15',
  needsResurvey: false,
  features: opts.unisex ? [{ feature: 'UNISEX', present: true }] : [{ feature: 'MALE', present: true }],
  surveys: [],
});
const s2Venue = (code: string, name: string, type: string, extra: Partial<Survey2Venue> = {}): Survey2Venue =>
  ({
    key: code,
    sourceKey: `survey2-venue:${code}`,
    code,
    name,
    type,
    lines: [],
    toiletStatus: 'HAS_TOILETS',
    note: null,
    openingHours: null,
    geocode: { strategy: 'place', query: name },
    usesNearbyVenueKey: null,
    premise: name,
    indexAddress: null,
    address: null,
    postalCode: null,
    ...extra,
  }) as Survey2Venue;
const s2Toilet = (sourceKey: string, sex: 'MALE' | 'FEMALE' | 'UNISEX', extra: Partial<Survey2Toilet> = {}): Survey2Toilet => {
  const code = sourceKey.slice('survey2:'.length).split('/')[0]!;
  return {
    sourceKey,
    venueKey: code,
    code,
    sex,
    location: '',
    label: null,
    level: null,
    accessNote: null,
    lines: [],
    status: 'ACTIVE',
    tier: 'VERIFIED',
    areaType: 'UNKNOWN',
    lastVerifiedAt: '2024-10-12T13:34:14+08:00',
    needsResurvey: false,
    features: [],
    surveys: [],
    photoUrl: null,
    ...extra,
  } as Survey2Toilet;
};
const geo = (lat: number, lng: number, name: string | null = null) => ({
  lat,
  lng,
  name,
  address: null,
  postalCode: null,
  planningArea: null,
  method: 'onemap' as const,
  query: '',
  matched: null,
  candidates: 1,
});

function inputs(): MatchInputs {
  const pilot = {
    source: { sheetId: 'x', observedAt: '2024-03-15', note: '' },
    venues: [pilotVenue('mrt-outram-park', 'Outram Park', 'MRT_STATION', ['EWL', 'NEL', 'TEL']), pilotVenue('mall-compass-one', 'Compass One', 'MALL'), pilotVenue('mrt-tiong-bahru', 'Tiong Bahru', 'MRT_STATION', ['EWL'])],
    toilets: [
      pilotToilet('sheet:outram-park-ewl', 'mrt-outram-park', ['EWL']),
      pilotToilet('sheet:outram-park-nel', 'mrt-outram-park', ['NEL']),
      pilotToilet('sheet:outram-park-tel', 'mrt-outram-park', ['TEL']),
      pilotToilet('sheet:compass-one-l1', 'mall-compass-one', [], { level: 'L1' }),
      pilotToilet('sheet:tiong-bahru-ewl', 'mrt-tiong-bahru', ['EWL'], { unisex: true }),
    ],
  } as unknown as Fieldwork;
  const survey2 = {
    source: { sheetId: 'y', observedFrom: '2024-08-24', observedTo: '2024-10-14', note: '' },
    venues: [
      s2Venue('TE17', 'Outram Park', 'MRT_STATION'),
      s2Venue('NE3', 'Outram Park', 'MRT_STATION'),
      s2Venue('EW17', 'Tiong Bahru', 'MRT_STATION'),
      s2Venue('EW13', 'City Hall', 'MRT_STATION'),
      s2Venue('TE23', 'Tanjong Rhu', 'MRT_STATION'),
      s2Venue('M9', 'Compass One', 'MALL', { premise: 'Compass Point (renamed Compass One)' }),
      s2Venue('M10', 'Bukit Panjang Plaza', 'MALL'),
      s2Venue('H85', 'Blk 79 Redhill Lane', 'HAWKER_CENTRE', { postalCode: '150079' }),
      s2Venue('C73', 'Coffeeshop, Blk 103 Gangsa Road', 'COFFEESHOP', { postalCode: '670103', premise: null }),
    ],
    toilets: [
      s2Toilet('survey2:TE17/male', 'MALE'),
      s2Toilet('survey2:TE17/female', 'FEMALE'),
      s2Toilet('survey2:NE3/male/1', 'MALE'),
      s2Toilet('survey2:NE3/male/2', 'MALE', { location: 'Exit B' }),
      s2Toilet('survey2:EW17/male', 'MALE'),
      s2Toilet('survey2:M9/male/b1', 'MALE', { level: 'B1', location: 'B1' }),
      s2Toilet('survey2:M9/male/l1', 'MALE', { level: 'L1', location: 'L1' }),
    ],
  } as unknown as Fieldwork2024b;
  return {
    survey2,
    pilot,
    pilotGeo: { 'mrt-outram-park': geo(1.2806, 103.8394), 'mall-compass-one': geo(1.392, 103.895) },
    survey2Geo: { M10: geo(1.37992, 103.764357), C73: geo(1.3787, 103.7685) },
    stations: [
      { qid: 'Q1901870', label: 'City Hall MRT station', name: 'City Hall', lat: 1.2932, lng: 103.8522, lines: ['EWL', 'NSL'], codes: ['EW13', 'NS25'], opening: null, states: [], instances: [], inUse: true, isMetro: true },
      { qid: 'Q18387904', label: 'Tanjong Rhu MRT station', name: 'Tanjong Rhu', lat: 1.297, lng: 103.873, lines: ['TEL'], codes: [], opening: null, states: [], instances: [], inUse: true, isMetro: true },
    ],
    hawkers: hawkerPoints({
      features: [
        { properties: { NAME: 'Redhill Lane Blk 79 (Redhill Market)', ADDRESSPOSTALCODE: '150079', STATUS: 'Existing' }, geometry: { type: 'Point', coordinates: [103.8186, 1.2868] } },
        { properties: { NAME: 'Some New Hawker', ADDRESSPOSTALCODE: '999999', STATUS: 'Under Construction' }, geometry: { type: 'Point', coordinates: [103.8, 1.3] } },
      ],
    }),
    osm: osmVenues([
      { type: 'way', id: 173144799, center: { lat: 1.37995, lon: 103.7644 }, tags: { shop: 'mall', toilets: 'yes', name: 'Bukit Panjang Plaza' } },
      // A coffeeshop-ish node 30 m away but with another name: not taken.
      { type: 'node', id: 1, lat: 1.3789, lon: 103.7686, tags: { amenity: 'food_court', toilets: 'yes', name: 'Kopitiam' } },
    ]),
    previous: null,
  };
}

describe('sameName', () => {
  it('matches exact names and word subsets of two or more words', () => {
    expect(sameName('Lau Pa Sat', 'LAU PA SAT')).toBe('exact');
    expect(sameName('Chong Pang', 'Chong Pang Market & Food Centre')).toBe('words');
    expect(sameName('Bukit Timah Interim Market', 'Bukit Timah Interim Hawker Centre and Market')).toBe('words');
    expect(sameName('Orchard', 'Orchard Plaza')).toBeNull();
    expect(sameName('Orchard Point', 'Orchard Plaza')).toBeNull();
  });
});

describe('matchSurvey2', () => {
  const { matches, review } = matchSurvey2(inputs());

  it('reuses pilot venues, Wikidata stations, data.gov.sg hawker centres and OSM malls; the rest are new', () => {
    const d = Object.fromEntries(Object.entries(matches.venues).map(([k, v]) => [k, v.existingVenueSourceKey]));
    expect(d).toEqual({
      TE17: 'sheet-venue:mrt-outram-park',
      NE3: 'sheet-venue:mrt-outram-park',
      EW17: 'sheet-venue:mrt-tiong-bahru',
      EW13: 'wikidata:Q1901870',
      TE23: 'wikidata:Q18387904',
      M9: 'sheet-venue:mall-compass-one',
      M10: 'osm-venue:way/173144799',
      H85: 'datagov-hawker:redhill-lane-blk-79-redhill-market',
      C73: null,
    });
    expect(matches.venues['EW13']!.via).toBe('wikidata-code');
    expect(matches.venues['TE23']!.via).toBe('wikidata-name');
  });

  it("attaches men's rows to the pilot toilet on the code's line", () => {
    expect(matches.attach['survey2:TE17/male']).toMatchObject({ pilotToiletSourceKey: 'sheet:outram-park-tel', via: 'station-line' });
    // Women's rows are never listed: they are always toilets of their own.
    expect(matches.attach['survey2:TE17/female']).toBeUndefined();
    // Two men's rows on one line: the one without a location is the pilot toilet, "Exit B" is another one.
    expect(matches.attach['survey2:NE3/male/1']!.pilotToiletSourceKey).toBe('sheet:outram-park-nel');
    expect(matches.attach['survey2:NE3/male/2']!.pilotToiletSourceKey).toBeNull();
    // The pilot only saw a handicapped (unisex) toilet at Tiong Bahru: the men's row is its own toilet, for review.
    expect(matches.attach['survey2:EW17/male']).toMatchObject({ pilotToiletSourceKey: null, via: 'no-pilot-toilet-of-this-sex' });
    // The pilot recorded L1 at Compass One: only the L1 row is that toilet.
    expect(matches.attach['survey2:M9/male/l1']).toMatchObject({ pilotToiletSourceKey: 'sheet:compass-one-l1', via: 'level' });
    expect(matches.attach['survey2:M9/male/b1']!.pilotToiletSourceKey).toBeNull();
    expect(review.map((r) => r.kind)).toEqual(expect.arrayContaining(['survey2-attach-none', 'survey2-attach-check', 'survey2-match-check']));
  });

  it('keeps locked entries', () => {
    const inp = inputs();
    inp.previous = {
      venues: { C73: { name: 'x', type: 'COFFEESHOP', existingVenueSourceKey: 'osm-venue:node/1', existingVenueName: 'Kopitiam', via: 'hand', detail: null, distanceM: null, locked: true } },
      attach: { 'survey2:NE3/male/2': { pilotToiletSourceKey: 'sheet:outram-park-nel', via: 'hand', detail: null, locked: true } },
    };
    const r = matchSurvey2(inp);
    expect(r.matches.venues['C73']!.existingVenueSourceKey).toBe('osm-venue:node/1');
    expect(r.matches.attach['survey2:NE3/male/2']!.pilotToiletSourceKey).toBe('sheet:outram-park-nel');
  });

  it('skips data.gov.sg centres under construction, as import:datagov does', () => {
    expect(inputs().hawkers.map((h) => h.sourceKey)).toEqual(['datagov-hawker:redhill-lane-blk-79-redhill-market']);
  });
});
