import { decodePolyline, encodePolyline } from './polyline.js';

describe('decodePolyline', () => {
  it('decodes the Google reference example', () => {
    // From the Google polyline algorithm docs.
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });

  it('empty string => no points', () => {
    expect(decodePolyline('')).toEqual([]);
  });

  it('round-trips Singapore coordinates', () => {
    const pts: [number, number][] = [
      [1.35208, 103.81984],
      [1.35001, 103.82222],
      [1.29027, 103.85195],
    ];
    expect(decodePolyline(encodePolyline(pts))).toEqual(pts);
  });

  it('throws on truncated input', () => {
    expect(() => decodePolyline('_p~iF~ps|U_')).toThrow();
  });
});
