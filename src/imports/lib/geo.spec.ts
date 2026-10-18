import { buildPlanningAreaIndex, planningAreaName } from '../geocode/planningArea.js';
import { parseArgv } from './argv.js';
import { parseDescriptionTable } from './datagov.js';
import { haversineM, inSingapore, pointInGeometry, pointInPolygon, PointIndex } from './geo.js';

const square = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

describe('point in polygon', () => {
  it('handles a simple polygon and its hole', () => {
    const poly = [square(0, 0, 10, 10), square(4, 4, 6, 6)];
    expect(pointInPolygon(1, 1, poly)).toBe(true);
    expect(pointInPolygon(5, 5, poly)).toBe(false); // in the hole
    expect(pointInPolygon(11, 5, poly)).toBe(false);
  });
  it('handles MultiPolygon and concave shapes', () => {
    const multi = { type: 'MultiPolygon', coordinates: [[square(0, 0, 1, 1)], [square(5, 5, 6, 6)]] };
    expect(pointInGeometry(5.5, 5.5, multi)).toBe(true);
    expect(pointInGeometry(3, 3, multi)).toBe(false);
    const u = { type: 'Polygon', coordinates: [[[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3], [0, 0]]] };
    expect(pointInGeometry(1.5, 2, u)).toBe(false); // inside the notch of the U
    expect(pointInGeometry(0.5, 2, u)).toBe(true);
  });
  it('builds a planning-area index from data.gov.sg style features', () => {
    const idx = buildPlanningAreaIndex({
      features: [
        { properties: { PLN_AREA_N: 'BEDOK' }, geometry: { type: 'Polygon', coordinates: [square(103.9, 1.3, 104.0, 1.35)] } },
        {
          properties: { Description: '<table><tr><th>PLN_AREA_N</th> <td>TOA PAYOH</td></tr></table>' },
          geometry: { type: 'MultiPolygon', coordinates: [[square(103.84, 1.32, 103.86, 1.34)]] },
        },
      ],
    });
    expect(idx.lookup(1.32, 103.95)).toBe('Bedok');
    expect(idx.lookup(1.33, 103.85)).toBe('Toa Payoh');
    expect(idx.lookup(1.2, 103.7)).toBeNull();
  });
});

describe('misc geo helpers', () => {
  it('haversine ~111 m per 0.001 deg latitude', () => {
    expect(haversineM(1.3, 103.8, 1.301, 103.8)).toBeCloseTo(111.2, 0);
  });
  it('Singapore bbox', () => {
    expect(inSingapore(1.29, 103.85)).toBe(true);
    expect(inSingapore(1.5, 103.85)).toBe(false);
  });
  it('PointIndex returns nearest first within radius', () => {
    const idx = new PointIndex<{ lat: number; lng: number; id: string }>();
    idx.add({ lat: 1.3, lng: 103.8, id: 'a' });
    idx.add({ lat: 1.3003, lng: 103.8, id: 'b' });
    idx.add({ lat: 1.31, lng: 103.8, id: 'far' });
    expect(idx.near(1.3001, 103.8, 60).map((x) => x.item.id)).toEqual(['a', 'b']);
  });
  it('parses data.gov.sg Description tables', () => {
    expect(parseDescriptionTable('<tr><th>NAME</th> <td>Aljunied CC</td></tr><tr><th>X</th><td>A &amp; B</td></tr>')).toEqual({ NAME: 'Aljunied CC', X: 'A & B' });
    expect(planningAreaName({ PLN_AREA_N: 'ANG MO KIO' })).toBe('Ang Mo Kio');
  });
});

describe('parseArgv', () => {
  it('parses commands, flags and values', () => {
    expect(parseArgv(['import:datagov', '--dataset', 'hawker', '--offline', '--no-close', '--x=1'])).toEqual({
      command: 'import:datagov',
      positionals: [],
      flags: { dataset: 'hawker', offline: true, close: false, x: '1' },
    });
  });
});
