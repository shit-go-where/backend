import type { Survey2Toilet } from '../curated/schema.js';
import { PROTECTED_SOURCES, planFeature, sgDate } from './fieldwork.js';
import { mergeWants, planOsmNear, planOsmSupersede, resolveVenue, type OsmNearCandidate } from './fieldwork2024b.js';
import { survey2SexOf, type SurveyedToilet } from '../osm/tags.js';

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

describe('planOsmNear (OSM toilets next to survey2 toilets at other venues)', () => {
  // 0.0001 deg of latitude is ~11 m. Mall "M" at 1.3 (survey2 toilets on its point), coffeeshop "C" 1 km north.
  const venues = new Map([
    ['M', { lat: 1.3, lng: 103.8 }],
    ['C', { lat: 1.31, lng: 103.8 }],
  ]);
  const s2 = (key: string, venueId: string, level: string | null): SurveyedToilet => ({
    id: key,
    sourceKey: key,
    venueId,
    source: 'FIELDWORK_2024_EXPANDED',
    lat: venues.get(venueId)!.lat,
    lng: 103.8,
    level,
    sex: survey2SexOf(key),
    placed: false,
  });
  const survey = [
    s2('survey2:M1/male/b1', 'M', 'B1'),
    s2('survey2:M1/female/b1', 'M', 'B1'),
    s2('survey2:M1/male/l2', 'M', 'L2'),
    s2('survey2:M1/female/l2', 'M', 'L2'),
    s2('survey2:M1/male/l3-1', 'M', 'L3'),
    s2('survey2:M1/male/l3-2', 'M', 'L3'),
    s2('survey2:C1/male', 'C', null),
    s2('survey2:C1/female', 'C', null),
  ];
  const osm = (key: string, lat: number, o: Partial<OsmNearCandidate> = {}): OsmNearCandidate => ({
    id: key,
    sourceKey: key,
    venueId: `osm-venue:${key}`,
    source: 'OSM',
    lat,
    lng: 103.8,
    activity: 0,
    level: null,
    sexes: [],
    generic: true,
    ...o,
  });
  const mall = [
    osm('osm:way/1', 1.3002, { level: 'B1', sexes: ['FEMALE'] }),
    osm('osm:way/2', 1.30022, { level: 'B1', sexes: ['MALE'] }),
    osm('osm:way/3', 1.30024, { level: 'B1', sexes: ['UNISEX'] }),
    osm('osm:way/4', 1.3003, { level: 'L1', sexes: ['FEMALE'] }),
    osm('osm:way/5', 1.29975, { level: 'L2' }),
    osm('osm:way/6', 1.2998, { level: 'L3' }),
    osm('osm:node/7', 1.30035, { level: 'L2', generic: false, venueId: 'library' }),
  ];
  const shop = [
    osm('osm:node/10', 1.31005), // ~6 m from the coffeeshop's toilets
    osm('osm:node/11', 1.31008, { generic: false }), // a community club next door
    osm('osm:node/12', 1.30995, { activity: 2 }),
    osm('osm:node/13', 1.31002, { sexes: ['UNISEX'] }),
  ];

  it('merges by floor: a sex tag picks one survey2 toilet, an untagged toilet takes one per sex', () => {
    const plan = planOsmNear(mall, survey, venues);
    expect(plan.merged.map((m) => [m.osm.sourceKey, m.into.map((t) => t.sourceKey), m.distanceM, m.rule])).toEqual([
      ['osm:way/1', ['survey2:M1/female/b1'], 22, 'floor'],
      ['osm:way/2', ['survey2:M1/male/b1'], 24, 'floor'],
      ['osm:way/5', ['survey2:M1/male/l2', 'survey2:M1/female/l2'], 28, 'floor'],
    ]);
    expect(plan.ambiguous).toEqual([
      { venueId: 'M', level: 'L3', osm: ['osm:way/6'], survey2: ['survey2:M1/male/l3-1', 'survey2:M1/male/l3-2'], reason: '2 MALE survey2 toilets on L3' },
    ]);
    // No unisex survey2 toilet on B1, nothing on L1, and the library's own toilet is not the mall's.
    expect(plan.retired).toEqual([]);
    expect(plan.near.map((n) => [n.osm.sourceKey, n.reason])).toEqual([
      // Measured from where the merged survey2 toilets are now.
      ['osm:way/3', 'not the same room (sex or level differs)'],
      ['osm:way/6', 'floor merge ambiguous: 2 MALE survey2 toilets on L3'],
      ['osm:way/4', 'not the same room (sex or level differs)'],
      ['osm:node/7', 'a place of its own'],
    ]);
  });

  it('calls it ambiguous when two OSM toilets claim one sex on a level', () => {
    const plan = planOsmNear([osm('osm:way/20', 1.3002, { level: 'B1', sexes: ['MALE'] }), osm('osm:way/21', 1.3003, { level: 'B1' })], survey, venues);
    expect(plan.merged).toEqual([]);
    expect(plan.ambiguous.map((a) => [a.level, a.osm, a.reason])).toEqual([['B1', ['osm:way/20', 'osm:way/21'], '2 OSM toilets for MALE on B1']]);
  });

  it('retires a generic OSM toilet in the same room as a survey2 toilet, keeps named places and used toilets', () => {
    const plan = planOsmNear(shop, survey, venues);
    expect(plan.retired.map((r) => [r.osm.sourceKey, r.by?.sourceKey, r.distanceM, r.rule])).toEqual([['osm:node/10', 'survey2:C1/male', 6, 'near-15m']]);
    expect(plan.keptInUse.map((k) => [k.osm.sourceKey, k.rule])).toEqual([['osm:node/12', 'near-15m']]);
    expect(plan.near.map((n) => [n.osm.sourceKey, n.reason])).toEqual([
      ['osm:node/13', 'not the same room (sex or level differs)'],
      ['osm:node/12', 'in use (would be retired)'],
      ['osm:node/11', 'a place of its own'],
    ]);
  });

  it('applies overrides.json osmOverrides before any rule', () => {
    const far = osm('osm:node/30', 1.32);
    const plan = planOsmNear([...shop, far, ...mall], survey, venues, {
      'osm:node/10': 'keep',
      'osm:node/30': 'retire',
      'osm:way/6': { mergeInto: 'survey2:M1/male/l3-2' },
      'osm:node/11': { mergeInto: 'survey2:C1/female' },
      'osm:node/99': 'retire',
    });
    expect(plan.retired.map((r) => [r.osm.sourceKey, r.rule])).toEqual([['osm:node/30', 'override']]);
    expect(plan.merged.filter((m) => m.rule === 'override').map((m) => [m.osm.sourceKey, m.into.map((t) => t.sourceKey)])).toEqual([
      ['osm:node/11', ['survey2:C1/female']],
      ['osm:way/6', ['survey2:M1/male/l3-2']],
    ]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.near.find((n) => n.osm.sourceKey === 'osm:node/10')?.reason).toBe('overrides.json: keep');
    expect(plan.unusedOverrides.map((u) => u.key)).toEqual(['osm:node/99']);
  });

  it('is a no-op once applied: merged survey2 toilets sit on the OSM position, nothing is left to retire', () => {
    const all = [...mall, ...shop];
    const first = planOsmNear(all, survey, venues);
    const gone = new Set([...first.merged, ...first.retired].map((x) => x.osm.sourceKey));
    const moved = new Map(first.merged.flatMap((m) => m.into.map((t) => [t.sourceKey, m.osm] as const)));
    const after = survey.map((t) => (moved.has(t.sourceKey) ? { ...t, lat: moved.get(t.sourceKey)!.lat, lng: moved.get(t.sourceKey)!.lng, placed: true } : t));
    const second = planOsmNear(all.filter((o) => !gone.has(o.sourceKey)), after, venues);
    expect([second.merged, second.retired, second.ambiguous.length]).toEqual([[], [], first.ambiguous.length]);
    expect(second.near.map((n) => n.osm.sourceKey).sort()).toEqual(first.near.map((n) => n.osm.sourceKey).sort());
  });
});
