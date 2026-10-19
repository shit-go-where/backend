import { appUrl, botDeepLink, googleMapsNavigateUrl, mapUrl, privacyUrl, stationUrl, toiletUrl } from './links.js';

const BASE = 'https://app.example';

describe('app links', () => {
  it('carry the three utm tags, lowercase', () => {
    expect(toiletUrl(BASE, 'abc', 'go')).toBe(
      `${BASE}/toilets/abc?utm_source=telegram&utm_medium=bot&utm_campaign=go`,
    );
    expect(stationUrl(`${BASE}/`, 'bishan', 'search')).toBe(
      `${BASE}/stations/bishan?utm_source=telegram&utm_medium=bot&utm_campaign=search`,
    );
    expect(mapUrl(BASE, 'start')).toBe(`${BASE}/?utm_source=telegram&utm_medium=bot&utm_campaign=start`);
    expect(privacyUrl(BASE)).toBe(`${BASE}/privacy?utm_source=telegram&utm_medium=bot&utm_campaign=privacy#telegram`);
  });

  it('never uses ?src= and follows whatever origin it is given', () => {
    const url = appUrl('http://localhost:3000', 'me', 'checkin');
    expect(url).toBe('http://localhost:3000/me?utm_source=telegram&utm_medium=bot&utm_campaign=checkin');
    expect(url).not.toContain('src=');
  });
});

describe('googleMapsNavigateUrl', () => {
  it('walks from the live position straight into navigation', () => {
    const url = new URL(googleMapsNavigateUrl({ lat: 1.3521, lng: 103.8198 }));
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/dir/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      api: '1',
      destination: '1.3521,103.8198',
      travelmode: 'walking',
      dir_action: 'navigate',
    });
  });
});

describe('botDeepLink', () => {
  it('opens a private chat with an optional start payload', () => {
    expect(botDeepLink('@testbot')).toBe('https://t.me/testbot');
    expect(botDeepLink('testbot', 'go')).toBe('https://t.me/testbot?start=go');
    expect(() => botDeepLink('testbot', 'has space')).toThrow();
    expect(() => botDeepLink('testbot', 'x'.repeat(65))).toThrow();
  });
});
