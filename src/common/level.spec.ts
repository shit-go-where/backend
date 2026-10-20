import { floorsBetween, levelFields, levelOrder, levelsOverlap, normalizeLevel } from './level.js';

describe('normalizeLevel', () => {
  it.each([
    ['basement 1', 'B1'],
    ['Basement 2', 'B2'],
    ['b1', 'B1'],
    ['B01', 'B1'],
    ['b 2', 'B2'],
    ['-1', 'B1'],
    ['-2', 'B2'],
    ['basement', 'B1'],
  ])('basements: %s → %s', (input, out) => expect(normalizeLevel(input)).toBe(out));

  it.each([
    ['level 3', 'L3'],
    ['Level 3', 'L3'],
    ['l3', 'L3'],
    ['L3', 'L3'],
    ['lvl 3', 'L3'],
    ['LVL3', 'L3'],
    ['3', 'L3'],
    ['03', 'L3'],
    ['#03', 'L3'],
    ['#03-12', 'L3'],
    ['#B1-05', 'B1'],
    ['3rd floor', 'L3'],
    ['floor 4', 'L4'],
    ['12', 'L12'],
  ])('levels: %s → %s', (input, out) => expect(normalizeLevel(input)).toBe(out));

  it.each([
    ['ground', 'L1'],
    ['Ground', 'L1'],
    ['g', 'L1'],
    ['G', 'L1'],
    ['gf', 'L1'],
    ['GF', 'L1'],
    ['ground floor', 'L1'],
    ['Ground Level', 'L1'],
    ['1', 'L1'],
    ['Level 1', 'L1'],
    // OpenStreetMap numbers the ground floor 0.
    ['0', 'L1'],
  ])('ground is L1: %s → %s', (input, out) => expect(normalizeLevel(input)).toBe(out));

  it.each([
    ['mezzanine', 'M'],
    ['Mezzanine', 'M'],
    ['m', 'M'],
    ['M', 'M'],
  ])('mezzanine: %s → %s', (input, out) => expect(normalizeLevel(input)).toBe(out));

  it.each([
    ['B1; L3', 'B1; L3'],
    ['b1;l3', 'B1; L3'],
    ['B1, L3', 'B1; L3'],
    ['B1/L3', 'B1; L3'],
    ['b1 & 3', 'B1; L3'],
    ['basement 1 and level 3', 'B1; L3'],
    ['B1 AND L3', 'B1; L3'],
    ['L1, 1, ground', 'L1'],
  ])('lists: %s → %s', (input, out) => expect(normalizeLevel(input)).toBe(out));

  it('trims, and keeps what it cannot read as typed', () => {
    expect(normalizeLevel('  L2  ')).toBe('L2');
    expect(normalizeLevel('  Roof garden ')).toBe('Roof garden');
    expect(normalizeLevel('Block 2/3A')).toBe('Block 2/3A');
    expect(normalizeLevel('Concourse')).toBe('Concourse');
    // A list keeps the parts it can't read, normalising the rest.
    expect(normalizeLevel('B1; Concourse')).toBe('B1; Concourse');
  });

  it('empty is null', () => {
    expect(normalizeLevel(null)).toBeNull();
    expect(normalizeLevel(undefined)).toBeNull();
    expect(normalizeLevel('')).toBeNull();
    expect(normalizeLevel('   ')).toBeNull();
    expect(normalizeLevel(' ; ')).toBeNull();
  });

  it('is idempotent', () => {
    for (const v of ['B1', 'L3', 'M', 'B1; L3', 'Roof garden', 'B1; Concourse', 'L12']) {
      expect(normalizeLevel(normalizeLevel(v))).toBe(normalizeLevel(v));
    }
  });
});

describe('levelOrder', () => {
  it('orders basements below ground and the mezzanine between L1 and L2', () => {
    expect(levelOrder('B2')).toBe(-2);
    expect(levelOrder('B1')).toBe(-1);
    expect(levelOrder('L1')).toBe(1);
    expect(levelOrder('M')).toBe(1.5);
    expect(levelOrder('L2')).toBe(2);
    expect(levelOrder('L10')).toBe(10);
  });
  it('takes the lowest level of a list', () => {
    expect(levelOrder('B1; L3')).toBe(-1);
    expect(levelOrder('L3; L2')).toBe(2);
    expect(levelOrder('Concourse; L4')).toBe(4);
  });
  it('reads un-normalised values', () => {
    expect(levelOrder('basement 2')).toBe(-2);
    expect(levelOrder('ground')).toBe(1);
    expect(levelOrder('#05')).toBe(5);
  });
  it('is null when unknown', () => {
    expect(levelOrder(null)).toBeNull();
    expect(levelOrder('')).toBeNull();
    expect(levelOrder('Concourse')).toBeNull();
  });
});

describe('levelFields', () => {
  it('normalises and orders together', () => {
    expect(levelFields(' level 3 ')).toEqual({ level: 'L3', levelOrder: 3 });
    expect(levelFields('Concourse')).toEqual({ level: 'Concourse', levelOrder: null });
    expect(levelFields(undefined)).toEqual({ level: null, levelOrder: null });
  });
});

describe('floorsBetween', () => {
  it('has no level 0', () => {
    expect(floorsBetween(-1, 1)).toBe(1);
    expect(floorsBetween(-2, 5)).toBe(6);
    expect(floorsBetween(3, 3)).toBe(0);
    expect(floorsBetween(1, 1.5)).toBe(0.5);
    expect(floorsBetween(4, 1)).toBe(3);
  });
});

describe('levelsOverlap', () => {
  it('compares normalised levels', () => {
    expect(levelsOverlap('1', 'L1')).toBe(true);
    expect(levelsOverlap('Level 1', 'L1')).toBe(true);
    expect(levelsOverlap('ground', '1')).toBe(true);
    expect(levelsOverlap('B1; L3', 'level 3')).toBe(true);
    expect(levelsOverlap('B1', 'L1')).toBe(false);
  });
  it('treats an unknown level as matching any', () => {
    expect(levelsOverlap(null, 'B1')).toBe(true);
    expect(levelsOverlap('B1', '')).toBe(true);
  });
});
