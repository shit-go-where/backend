import type { Survey2Toilet } from '../curated/schema.js';
import { PROTECTED_SOURCES, planFeature, sgDate } from './fieldwork.js';
import { mergeWants, planOsmSupersede, resolveVenue } from './fieldwork2024b.js';

const march = new Date('2024-03-15T00:00:00+08:00');
const october = new Date('2024-10-12T13:34:14+08:00');

describe('planFeature with newer-wins between the two 2024 surveys', () => {
  const want = { feature: 'HAND_SOAP' as const, present: true, source: 'FIELDWORK_2024_EXPANDED' as const, observedAt: october };
  const NEWER = ['FIELDWORK_2024' as const];
  it('replaces an older pilot observation', () => {
    expect(planFeature({ feature: 'HAND_SOAP', present: false, source: 'FIELDWORK_2024', observedAt: march }, want, PROTECTED_SOURCES, NEWER)).toBe('update');
    expect(planFeature({ feature: 'HAND_SOAP', present: true, source: 'FIELDWORK_2024', observedAt: march }, want, PROTECTED_SOURCES, NEWER)).toBe('update');
  });
  it('keeps a pilot observation that is newer than the row', () => {
    const later = new Date('2025-01-01T00:00:00+08:00');
    expect(planFeature({ feature: 'HAND_SOAP', present: false, source: 'FIELDWORK_2024', observedAt: later }, want, PROTECTED_SOURCES, NEWER)).toBe('protected');
  });
  it('still never touches COMMUNITY / ADMIN, and keeps its own unchanged rows', () => {
    expect(planFeature({ feature: 'HAND_SOAP', present: false, source: 'COMMUNITY', observedAt: march }, want, PROTECTED_SOURCES, NEWER)).toBe('protected');
    expect(planFeature({ feature: 'HAND_SOAP', present: false, source: 'ADMIN', observedAt: march }, want, PROTECTED_SOURCES, NEWER)).toBe('protected');
    expect(planFeature({ ...want }, want, PROTECTED_SOURCES, NEWER)).toBe('keep');
  });
  it('reads curated dates and Singapore timestamps', () => {
    expect(sgDate('2024-03-15').toISOString()).toBe('2024-03-14T16:00:00.000Z');
    expect(sgDate('2024-10-12T13:34:14+08:00').toISOString()).toBe('2024-10-12T05:34:14.000Z');
  });
});

describe('mergeWants', () => {
  const row = (at: string, features: [string, boolean][]) =>
    ({ lastVerifiedAt: at, features: features.map(([feature, present]) => ({ feature, present })) }) as unknown as Survey2Toilet;
  it('takes each feature from the newest row that has it', () => {
    const w = mergeWants([
      row('2024-10-13T13:25:00+08:00', [['HAND_SOAP', false]]),
      row('2024-09-14T18:08:00+08:00', [['HAND_SOAP', true], ['BIDET', true]]),
    ]);
    expect(w.map((x) => [x.feature, x.present, x.observedAt.toISOString(), x.source])).toEqual([
      ['BIDET', true, '2024-09-14T10:08:00.000Z', 'FIELDWORK_2024_EXPANDED'],
      ['HAND_SOAP', false, '2024-10-13T05:25:00.000Z', 'FIELDWORK_2024_EXPANDED'],
    ]);
  });
});

describe('resolveVenue', () => {
  const v = (sourceKey: string, externalIds: unknown, source = 'OSM') => ({ sourceKey, externalIds, source }) as never;
  const venues = [
    v('sheet-venue:mrt-outram-park', { sheetVenueKey: 'mrt-outram-park', wikidata: ['Q1'] }, 'FIELDWORK_2024'),
    v('osm-venue:way/9', { osm: 'way/9', datagov: { hawker: ['redhill-lane-blk-79-redhill-market'] } }),
    v('wikidata:Q2', { wikidata: ['Q2'] }, 'WIKIDATA'),
  ];
  it('finds a venue by sourceKey or through the link another importer left', () => {
    expect(resolveVenue('wikidata:Q2', venues)).toBe(venues[2]);
    expect(resolveVenue('wikidata:Q1', venues)).toBe(venues[0]);
    expect(resolveVenue('datagov-hawker:redhill-lane-blk-79-redhill-market', venues)).toBe(venues[1]);
    expect(resolveVenue('osm-venue:way/9', venues)).toBe(venues[1]);
    expect(resolveVenue('datagov-hawker:nowhere', venues)).toBeNull();
  });
});

describe('planOsmSupersede (import:osm dedupe, the other way round)', () => {
  // 0.0001 deg of latitude is ~11 m.
  const t = (sourceKey: string, venueId: string, lat: number, source = 'OSM', activity = 0) =>
    ({ id: sourceKey, sourceKey, venueId, source, lat, lng: 103.8, activity });
  const s2 = [t('survey2:H1/male', 'hc', 1.3, 'FIELDWORK_2024_EXPANDED'), t('survey2:H1/female', 'hc', 1.3001, 'FIELDWORK_2024_EXPANDED')];
  it('removes an untouched OSM toilet at the same venue within 40 m, naming the nearest survey2 toilet', () => {
    const { remove, keep } = planOsmSupersede([t('osm:node/1', 'hc', 1.30008)], s2);
    expect(remove.map((r) => [r.osm.sourceKey, r.by.sourceKey, r.distanceM])).toEqual([['osm:node/1', 'survey2:H1/female', 2]]);
    expect(keep).toEqual([]);
  });
  it('keeps OSM toilets further than 40 m, at another venue, or that people have used', () => {
    const { remove, keep } = planOsmSupersede(
      [t('osm:node/2', 'hc', 1.3005), t('osm:node/3', 'mall', 1.3), t('osm:node/4', 'hc', 1.3, 'OSM', 1)],
      s2,
    );
    expect(remove).toEqual([]);
    expect(keep.map((k) => [k.osm.sourceKey, k.by.sourceKey])).toEqual([['osm:node/4', 'survey2:H1/male']]);
  });
  it('only survey2 toilets supersede, and only OSM toilets are superseded', () => {
    const pilot = [t('sheet:x', 'hc', 1.3, 'FIELDWORK_2024')];
    expect(planOsmSupersede([t('osm:node/5', 'hc', 1.3)], pilot).remove).toEqual([]);
    expect(planOsmSupersede([t('community:1', 'hc', 1.3, 'COMMUNITY')], s2).remove).toEqual([]);
  });
});
