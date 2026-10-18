import { lineCodeFromStationCode, lineCodeFromWikidata, processBindings, stationName } from '../wikidata/stations.js';
import { expandParkName, isMinorParkSpace, sameish } from '../datagov/import.js';
import { planFeature, stableStringify } from './fieldwork.js';

const at = new Date('2024-03-15T00:00:00+08:00');

describe('planFeature (provenance rules)', () => {
  const want = { feature: 'HAND_SOAP' as const, present: true, source: 'FIELDWORK_2024' as const, observedAt: at };
  it('creates, keeps and updates fieldwork rows', () => {
    expect(planFeature(undefined, want)).toBe('create');
    expect(planFeature({ feature: 'HAND_SOAP', present: true, source: 'FIELDWORK_2024', observedAt: at }, want)).toBe('keep');
    expect(planFeature({ feature: 'HAND_SOAP', present: false, source: 'FIELDWORK_2024', observedAt: at }, want)).toBe('update');
    expect(planFeature({ feature: 'HAND_SOAP', present: false, source: 'OSM', observedAt: at }, want)).toBe('update');
  });
  it('never overwrites COMMUNITY or ADMIN rows from an import', () => {
    expect(planFeature({ feature: 'HAND_SOAP', present: false, source: 'COMMUNITY', observedAt: at }, want)).toBe('protected');
    expect(planFeature({ feature: 'HAND_SOAP', present: false, source: 'ADMIN', observedAt: at }, want)).toBe('protected');
  });
  it('OSM also protects FIELDWORK rows when asked', () => {
    const osm = { ...want, source: 'OSM' as const };
    expect(planFeature({ feature: 'HAND_SOAP', present: false, source: 'FIELDWORK_2024', observedAt: at }, osm, ['FIELDWORK_2024', 'COMMUNITY', 'ADMIN'])).toBe('protected');
  });
  it('ADMIN enrichment overrides anything but keeps an unchanged ADMIN row', () => {
    const admin = { ...want, source: 'ADMIN' as const };
    expect(planFeature({ feature: 'HAND_SOAP', present: false, source: 'COMMUNITY', observedAt: at }, admin)).toBe('update');
    expect(planFeature({ feature: 'HAND_SOAP', present: true, source: 'ADMIN', observedAt: new Date() }, admin)).toBe('keep');
  });
});

describe('stableStringify', () => {
  it('ignores key order and handles dates', () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(stableStringify({ a: [{ x: 1, y: 2 }], b: 1 }));
    expect(stableStringify({ d: at })).toBe('{"d":"2024-03-14T16:00:00.000Z"}');
  });
});

describe('Wikidata helpers', () => {
  it('maps line labels and station codes', () => {
    expect(lineCodeFromWikidata('Thomson–East Coast Line')).toBe('TEL');
    expect(lineCodeFromWikidata('North–South Line')).toBe('NSL');
    expect(lineCodeFromWikidata('Cross Island Line')).toBeNull();
    expect(lineCodeFromStationCode('CG2')).toBe('EWL');
    expect(lineCodeFromStationCode('PW2')).toBe('PGLRT');
    expect(stationName('Bayshore MRT station')).toBe('Bayshore');
    expect(stationName('Marina Bay station')).toBe('Marina Bay');
  });
  it('keeps in-use stations, drops planned ones', () => {
    const b = (qid: string, label: string, state?: string, opening?: string) => ({
      st: { value: `http://www.wikidata.org/entity/${qid}` },
      stLabel: { value: label },
      coord: { value: 'Point(103.9 1.3)' },
      instLabel: { value: 'metro station' },
      ...(state ? { state: { value: `http://www.wikidata.org/entity/${state}` } } : {}),
      ...(opening ? { opening: { value: `${opening}T00:00:00Z` } } : {}),
    });
    const out = processBindings([b('Q1', 'Bayshore MRT station', 'Q55654238'), b('Q2', 'Bedok South MRT station', 'Q12377751'), b('Q3', 'Old MRT station', undefined, '1990-01-01')]);
    expect(out.map((s) => [s.qid, s.inUse])).toEqual([['Q1', true], ['Q2', false], ['Q3', true]]);
    expect(out[0]).toMatchObject({ lat: 1.3, lng: 103.9, name: 'Bayshore' });
  });
});

describe('data.gov.sg helpers', () => {
  it('expands NParks abbreviations and filters minor spaces', () => {
    expect(expandParkName('JLN KEBAYA PK')).toBe('Jalan Kebaya Park');
    expect(isMinorParkSpace('GROVE LANE PG')).toBe(true);
    expect(isMinorParkSpace('SUNRISE DR PG I')).toBe(true);
    expect(isMinorParkSpace('BISHAN-ANG MO KIO PARK')).toBe(false);
  });
  it('treats CC and Community Club as the same name', () => {
    expect(sameish('Marymount CC', 'Marymount Community Club')).toBe(true);
    expect(sameish('Bukit Panjang Hawker Centre', 'Bukit Panjang Hawker Center')).toBe(true);
    expect(sameish('Aljunied CC', 'Bedok CC')).toBe(false);
  });
});
