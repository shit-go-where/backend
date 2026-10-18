import {
  displayName,
  geocodeQueryFor,
  groupVenues,
  parseLocation,
  splitLines,
  toiletLabel,
  toiletSourceKey,
  venueKeyFor,
} from './location.js';

describe('splitLines', () => {
  it('handles commas, slashes, spacing and case', () => {
    expect(splitLines('NSL, EWL')).toEqual(['NSL', 'EWL']);
    expect(splitLines('DTL / CCL')).toEqual(['DTL', 'CCL']);
    expect(splitLines('CCL/NEL')).toEqual(['CCL', 'NEL']);
    expect(splitLines('tel')).toEqual(['TEL']);
    expect(splitLines('EWL EWL')).toEqual(['EWL']);
    expect(splitLines('Jewel L3')).toEqual([]);
  });
});

describe('parseLocation', () => {
  it.each([
    ['Jurong East NSL, EWL', 'Jurong East', ['NSL', 'EWL'], null, null],
    ['Harbourfront CCL / NEL', 'Harbourfront', ['CCL', 'NEL'], null, null],
    ['Bayfront DTL / CCL', 'Bayfront', ['DTL', 'CCL'], null, null],
    ['Marina Bay TEL ', 'Marina Bay', ['TEL'], null, null],
    ['Marina Bay TEL Linkway', 'Marina Bay', ['TEL'], null, 'Linkway'],
    ['one-north CCL', 'one-north', ['CCL'], null, null],
    ['Jewel L3', 'Jewel', [], 'L3', null],
    ['Woodleigh Mall B1', 'Woodleigh Mall', [], 'B1', null],
    ['HDB Hub (Toa Payoh) L1', 'HDB Hub (Toa Payoh)', [], 'L1', null],
    ['Marina Bay Sands ', 'Marina Bay Sands', [], null, null],
    ['Kim San Leng @ Bukit Panjang Blk 259', 'Kim San Leng @ Bukit Panjang Blk 259', [], null, null],
    ['Choa Chu Kang BI', 'Choa Chu Kang BI', [], null, null],
    ['Marymount CC L2', 'Marymount CC', [], 'L2', null],
    ['Chong Pang', 'Chong Pang', [], null, null],
  ])('%s', (raw, name, lines, level, suffix) => {
    const p = parseLocation(raw);
    expect(p.name).toBe(name);
    expect(p.lines).toEqual(lines);
    expect(p.level).toBe(level);
    expect(p.suffix).toBe(suffix);
  });

  it('normalises whitespace in the original', () => {
    expect(parseLocation('  Marina  Bay TEL ').original).toBe('Marina Bay TEL');
  });
});

describe('venue keys and grouping', () => {
  it('puts every line of an interchange in one venue', () => {
    const rows = ['Outram Park EWL', 'Outram Park NEL', 'Outram Park TEL', 'Bugis EWL', 'Bugis DTL', 'Marina Bay TEL ', 'Marina Bay TEL Linkway', 'Marina Bay NSL'].map(
      (l) => ({ type: 'MRT_STATION' as const, parsed: parseLocation(l) }),
    );
    const g = groupVenues(rows);
    expect([...g.keys()].sort()).toEqual(['mrt-bugis', 'mrt-marina-bay', 'mrt-outram-park']);
    expect(g.get('mrt-outram-park')).toHaveLength(3);
    expect(g.get('mrt-marina-bay')).toHaveLength(3);
  });

  it('keeps different venue types apart even with similar names', () => {
    expect(venueKeyFor('Woodleigh', 'MRT_STATION')).toBe('mrt-woodleigh');
    expect(venueKeyFor('Woodleigh Mall', 'MALL')).toBe('mall-woodleigh-mall');
    expect(venueKeyFor('Bukit Panjang BI', 'BUS_INTERCHANGE')).toBe('bi-bukit-panjang-bus-interchange');
  });

  it('builds stable toilet source keys', () => {
    expect(toiletSourceKey('Harbourfront CCL / NEL')).toBe('sheet:harbourfront-ccl-nel');
    expect(toiletSourceKey('Marina Bay TEL ')).toBe('sheet:marina-bay-tel');
    expect(toiletSourceKey('Kim San Leng @ Bukit Panjang Blk 259')).toBe('sheet:kim-san-leng-at-bukit-panjang-blk-259');
  });

  it('expands BI / CC in display names', () => {
    expect(displayName('Punggol BI', 'BUS_INTERCHANGE')).toBe('Punggol Bus Interchange');
    expect(displayName('Marymount CC', 'COMMUNITY_CLUB')).toBe('Marymount Community Club');
  });
});

describe('toiletLabel', () => {
  it('labels toilets by line only when the venue needs it', () => {
    expect(toiletLabel(parseLocation('Outram Park EWL'), ['EWL', 'NEL', 'TEL'], 3)).toBe('EWL side');
    expect(toiletLabel(parseLocation('Marina Bay TEL Linkway'), ['NSL', 'TEL'], 3)).toBe('TEL Linkway');
    expect(toiletLabel(parseLocation('Bishan NSL'), ['NSL', 'CCL'], 1)).toBe('NSL side');
    expect(toiletLabel(parseLocation('Jurong East NSL, EWL'), ['NSL', 'EWL'], 1)).toBeNull();
    expect(toiletLabel(parseLocation('Jewel L3'), [], 1)).toBeNull();
  });
});

describe('geocodeQueryFor', () => {
  it('uses "<name> MRT STATION" for stations and block numbers for coffee shops', () => {
    expect(geocodeQueryFor('Outram Park', 'MRT_STATION')).toEqual({ strategy: 'mrt', query: 'Outram Park MRT STATION' });
    expect(geocodeQueryFor('Kim San Leng @ Bukit Panjang Blk 259', 'COFFEESHOP').query).toBe('259 Bukit Panjang');
    expect(geocodeQueryFor('Eunos Block 2A Kimly', 'COFFEESHOP').query).toBe('2A Eunos');
    expect(geocodeQueryFor('Choa Chu Kang BI', 'BUS_INTERCHANGE').query).toBe('Choa Chu Kang Bus Interchange');
  });
});
