import { isOpenAt, parseOsmOpeningHours, parseTime, sgtClock, type OpeningHours } from './opening-hours.js';

// Week of 2024-03-11 (Mon) .. 2024-03-17 (Sun), Singapore local times.
const sgt = (local: string) => new Date(`${local}+08:00`);
const MON = '2024-03-11';
const TUE = '2024-03-12';
const FRI = '2024-03-15';
const SAT = '2024-03-16';
const SUN = '2024-03-17';
const osm = (value: string): OpeningHours => ({ type: 'osm', value });

describe('parseTime', () => {
  it('parses valid times', () => {
    expect(parseTime('00:00')).toBe(0);
    expect(parseTime('8:30')).toBe(510);
    expect(parseTime('23:59')).toBe(1439);
    expect(parseTime('24:00')).toBe(1440);
  });
  it('rejects malformed times', () => {
    expect(parseTime('24:30')).toBeNull();
    expect(parseTime('12:60')).toBeNull();
    expect(parseTime('noon')).toBeNull();
    expect(parseTime('1200')).toBeNull();
  });
});

describe('sgtClock', () => {
  it('converts UTC to Singapore time', () => {
    // 2024-03-11 17:30 UTC = 2024-03-12 01:30 SGT (Tuesday)
    expect(sgtClock(new Date('2024-03-11T17:30:00Z'))).toEqual({ day: 2, minutes: 90 });
    expect(sgtClock(sgt(`${MON}T08:00`))).toEqual({ day: 1, minutes: 480 });
  });
});

describe('isOpenAt: basics', () => {
  it('null/undefined/garbage => null', () => {
    expect(isOpenAt(null, new Date())).toBeNull();
    expect(isOpenAt(undefined, new Date())).toBeNull();
    expect(isOpenAt({ type: 'nope' } as unknown as OpeningHours, new Date())).toBeNull();
    expect(isOpenAt('24/7' as unknown as OpeningHours, new Date())).toBeNull();
  });
  it('always => true', () => {
    expect(isOpenAt({ type: 'always' }, sgt(`${SUN}T03:00`))).toBe(true);
  });
});

describe('isOpenAt: weekly', () => {
  const weekdays: OpeningHours = {
    type: 'weekly',
    periods: [
      { days: [1, 2, 3, 4, 5], open: '08:00', close: '20:00' },
      { days: [0, 6], open: '10:00', close: '18:00' },
    ],
  };
  it('open inside period, closed outside, close is exclusive', () => {
    expect(isOpenAt(weekdays, sgt(`${MON}T08:00`))).toBe(true);
    expect(isOpenAt(weekdays, sgt(`${MON}T19:59`))).toBe(true);
    expect(isOpenAt(weekdays, sgt(`${MON}T20:00`))).toBe(false);
    expect(isOpenAt(weekdays, sgt(`${MON}T07:59`))).toBe(false);
    expect(isOpenAt(weekdays, sgt(`${SAT}T09:00`))).toBe(false);
    expect(isOpenAt(weekdays, sgt(`${SUN}T17:00`))).toBe(true);
  });

  it('uses Singapore time, not UTC', () => {
    // 2024-03-11 01:00 UTC = 09:00 SGT Monday: open
    expect(isOpenAt(weekdays, new Date('2024-03-11T01:00:00Z'))).toBe(true);
    // 2024-03-11 13:00 UTC = 21:00 SGT Monday: closed
    expect(isOpenAt(weekdays, new Date('2024-03-11T13:00:00Z'))).toBe(false);
  });

  it('periods crossing midnight spill into the next day', () => {
    const mrt: OpeningHours = {
      type: 'weekly',
      periods: [{ days: [0, 1, 2, 3, 4, 5, 6], open: '05:30', close: '00:30' }],
      inferred: true,
    };
    expect(isOpenAt(mrt, sgt(`${MON}T23:59`))).toBe(true);
    expect(isOpenAt(mrt, sgt(`${TUE}T00:15`))).toBe(true);
    expect(isOpenAt(mrt, sgt(`${TUE}T00:30`))).toBe(false);
    expect(isOpenAt(mrt, sgt(`${TUE}T03:00`))).toBe(false);
    expect(isOpenAt(mrt, sgt(`${TUE}T05:30`))).toBe(true);
  });

  it('spill-over only applies when the previous day has the period', () => {
    const friNight: OpeningHours = {
      type: 'weekly',
      periods: [{ days: [5], open: '18:00', close: '02:00' }],
    };
    expect(isOpenAt(friNight, sgt(`${SAT}T01:00`))).toBe(true);
    expect(isOpenAt(friNight, sgt(`${FRI}T01:00`))).toBe(false);
    expect(isOpenAt(friNight, sgt(`${FRI}T18:30`))).toBe(true);
  });

  it('Saturday night spills into Sunday (week wrap)', () => {
    const satNight: OpeningHours = { type: 'weekly', periods: [{ days: [6], open: '20:00', close: '03:00' }] };
    expect(isOpenAt(satNight, sgt(`${SUN}T02:00`))).toBe(true);
  });

  it('00:00-24:00 is all day', () => {
    const allDay: OpeningHours = { type: 'weekly', periods: [{ days: [1], open: '00:00', close: '24:00' }] };
    expect(isOpenAt(allDay, sgt(`${MON}T00:00`))).toBe(true);
    expect(isOpenAt(allDay, sgt(`${MON}T23:59`))).toBe(true);
    expect(isOpenAt(allDay, sgt(`${TUE}T00:00`))).toBe(false);
  });

  it('empty periods => closed', () => {
    expect(isOpenAt({ type: 'weekly', periods: [] }, sgt(`${MON}T12:00`))).toBe(false);
  });

  it('malformed periods => null', () => {
    const bad = (periods: unknown) =>
      isOpenAt({ type: 'weekly', periods } as unknown as OpeningHours, sgt(`${MON}T12:00`));
    expect(bad(undefined)).toBeNull();
    expect(bad([{ days: [1], open: '8am', close: '20:00' }])).toBeNull();
    expect(bad([{ days: [7], open: '08:00', close: '20:00' }])).toBeNull();
    expect(bad([{ days: 'Mo', open: '08:00', close: '20:00' }])).toBeNull();
    expect(bad([null])).toBeNull();
  });
});

describe('isOpenAt: osm strings', () => {
  it('24/7', () => {
    expect(isOpenAt(osm('24/7'), sgt(`${SUN}T03:00`))).toBe(true);
    expect(isOpenAt(osm(' 24/7 '), sgt(`${SUN}T03:00`))).toBe(true);
  });

  it('weekday / weekend rules', () => {
    const h = osm('Mo-Fr 08:00-20:00; Sa,Su 10:00-18:00');
    expect(isOpenAt(h, sgt(`${FRI}T08:30`))).toBe(true);
    expect(isOpenAt(h, sgt(`${FRI}T21:00`))).toBe(false);
    expect(isOpenAt(h, sgt(`${SAT}T09:00`))).toBe(false);
    expect(isOpenAt(h, sgt(`${SAT}T10:00`))).toBe(true);
    expect(isOpenAt(h, sgt(`${SUN}T18:00`))).toBe(false);
  });

  it('past midnight: Mo-Su 06:00-01:00', () => {
    const h = osm('Mo-Su 06:00-01:00');
    expect(isOpenAt(h, sgt(`${MON}T00:30`))).toBe(true); // spill from Sunday
    expect(isOpenAt(h, sgt(`${MON}T01:00`))).toBe(false);
    expect(isOpenAt(h, sgt(`${MON}T05:59`))).toBe(false);
    expect(isOpenAt(h, sgt(`${MON}T06:00`))).toBe(true);
    expect(isOpenAt(h, sgt(`${MON}T23:00`))).toBe(true);
  });

  it('later rules override earlier ones; off/closed', () => {
    const h = osm('Mo-Su 08:00-22:00; Su off');
    expect(isOpenAt(h, sgt(`${SUN}T12:00`))).toBe(false);
    expect(isOpenAt(h, sgt(`${SAT}T12:00`))).toBe(true);
    expect(isOpenAt(osm('Mo-Fr 09:00-17:00; Sa closed'), sgt(`${SAT}T12:00`))).toBe(false);
  });

  it('multiple ranges per day and comma-separated rules', () => {
    const h = osm('Mo-Fr 08:00-12:00,13:00-17:00, Sa 09:00-12:00');
    expect(isOpenAt(h, sgt(`${MON}T12:30`))).toBe(false);
    expect(isOpenAt(h, sgt(`${MON}T13:30`))).toBe(true);
    expect(isOpenAt(h, sgt(`${SAT}T10:00`))).toBe(true);
    expect(isOpenAt(h, sgt(`${SUN}T10:00`))).toBe(false);
  });

  it('wrapping day ranges and times without day selector', () => {
    const h = osm('Fr-Mo 10:00-14:00');
    expect(isOpenAt(h, sgt(`${SUN}T11:00`))).toBe(true);
    expect(isOpenAt(h, sgt(`${MON}T11:00`))).toBe(true);
    expect(isOpenAt(h, sgt(`${TUE}T11:00`))).toBe(false);
    expect(isOpenAt(osm('07:00-23:00'), sgt(`${TUE}T22:00`))).toBe(true);
    expect(isOpenAt(osm('07:00-23:00'), sgt(`${TUE}T23:30`))).toBe(false);
  });

  it('PH tokens are ignored, single-digit hours accepted', () => {
    const h = osm('Mo-Fr,PH 8:00-18:00');
    expect(isOpenAt(h, sgt(`${TUE}T08:30`))).toBe(true);
    expect(isOpenAt(osm('Mo-Fr 08:00-18:00; PH off'), sgt(`${TUE}T09:00`))).toBe(true);
  });

  it('day selector alone means all day', () => {
    expect(isOpenAt(osm('Mo-Fr'), sgt(`${TUE}T03:00`))).toBe(true);
    expect(isOpenAt(osm('Mo-Fr'), sgt(`${SAT}T03:00`))).toBe(false);
  });

  it('unknown syntax => null', () => {
    for (const v of [
      '',
      'sunrise-sunset',
      'Jan-Mar Mo-Fr 08:00-18:00',
      'Mo-Fr 08:00-18:00+',
      'Mo-Fr 08:00-26:00',
      'by appointment',
      'Mo-Fr 8am-6pm',
    ]) {
      expect(isOpenAt(osm(v), sgt(`${TUE}T09:00`)), v).toBeNull();
    }
  });
});

describe('parseOsmOpeningHours', () => {
  it('returns always for 24/7 and periods otherwise', () => {
    expect(parseOsmOpeningHours('24/7')).toBe('always');
    expect(parseOsmOpeningHours('Sa,Su 10:00-18:00')).toEqual([
      { days: [0], open: '10:00', close: '18:00' },
      { days: [6], open: '10:00', close: '18:00' },
    ]);
  });
});
