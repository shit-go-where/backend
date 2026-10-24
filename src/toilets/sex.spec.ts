import { sexOf, sexWhere, usableBy } from './sex.js';

describe('sexOf', () => {
  it('reads MALE / FEMALE / UNISEX features', () => {
    expect(sexOf(['MALE', 'HAND_SOAP'])).toBe('MALE');
    expect(sexOf(['FEMALE'])).toBe('FEMALE');
    expect(sexOf(['UNISEX', 'ACCESSIBLE'])).toBe('UNISEX');
  });
  it('is unknown with both or neither', () => {
    expect(sexOf(['MALE', 'FEMALE'])).toBeNull();
    expect(sexOf(['BIDET'])).toBeNull();
  });
  it('lets UNISEX win over a single MALE or FEMALE', () => {
    expect(sexOf(['MALE', 'UNISEX'])).toBe('UNISEX');
  });
});

describe('usableBy', () => {
  it("keeps one's own, unisex and unknown toilets", () => {
    expect([ 'MALE', 'FEMALE', 'UNISEX', null ].map((s) => usableBy(s as never, 'MALE'))).toEqual([true, false, true, true]);
    expect([ 'MALE', 'FEMALE', 'UNISEX', null ].map((s) => usableBy(s as never, 'FEMALE'))).toEqual([false, true, true, true]);
  });
  it('keeps everything without a preference', () => {
    expect(usableBy('FEMALE', undefined)).toBe(true);
  });
});

describe('sexWhere', () => {
  it("drops toilets that are only the other sex's", () => {
    expect(sexWhere('MALE')).toEqual({
      NOT: {
        AND: [
          { features: { some: { feature: 'FEMALE', present: true } } },
          { features: { none: { feature: 'MALE', present: true } } },
          { features: { none: { feature: 'UNISEX', present: true } } },
        ],
      },
    });
  });
});
