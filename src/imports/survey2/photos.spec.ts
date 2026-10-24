import type { Fieldwork2024b, Survey2Matches } from '../curated/schema.js';
import { driveDownloadUrl, isDriveSignIn, planPhotos, probeDrivePhoto, runSurvey2Photos, type FetchLike } from './photos.js';

const SIGN_IN_HTML =
  '<!doctype html><html lang="en"><head><title>Sign in - Google Accounts</title></head><body><form action="https://accounts.google.com/v3/signin/identifier?continue=https://drive.google.com/uc"></form></body></html>';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** A Response as fetch() would give it after following redirects to `finalUrl`. */
function response(body: string | Buffer, contentType: string, finalUrl: string, status = 200): Response {
  const r = new Response(typeof body === 'string' ? body : new Uint8Array(body), { status, headers: { 'content-type': contentType } });
  Object.defineProperty(r, 'url', { value: finalUrl });
  return r;
}

const signInFetch: FetchLike = async () =>
  response(SIGN_IN_HTML, 'text/html; charset=utf-8', 'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fdrive.google.com');

describe('Drive sign-in detection', () => {
  it('treats the Google sign-in page as "not shared"', () => {
    expect(isDriveSignIn('https://accounts.google.com/ServiceLogin?continue=x', 'text/html', '')).toBe(true);
    // Same page served without the redirect being visible: judged by the HTML.
    expect(isDriveSignIn('https://drive.google.com/uc?export=download&id=x', 'text/html; charset=utf-8', SIGN_IN_HTML)).toBe(true);
    expect(isDriveSignIn('https://drive.usercontent.google.com/download?id=x', 'image/jpeg', 'ÿØ')).toBe(false);
    expect(isDriveSignIn('https://drive.google.com/uc?id=x', 'text/html', '<html><title>Google Drive - Virus scan warning</title></html>')).toBe(false);
  });

  it('probes one file: sign-in page, image, 404, other HTML', async () => {
    expect(await probeDrivePhoto('abc1234567', signInFetch)).toMatchObject({ status: 'not-shared' });
    const img = await probeDrivePhoto('abc1234567', async (url) => {
      expect(url).toBe(driveDownloadUrl('abc1234567'));
      return response(JPEG, 'image/jpeg', 'https://drive.usercontent.google.com/download?id=abc1234567');
    });
    expect(img).toMatchObject({ status: 'image', contentType: 'image/jpeg' });
    expect(await probeDrivePhoto('abc1234567', async () => response('Not Found', 'text/html', 'https://drive.google.com/uc', 404))).toMatchObject({
      status: 'not-found',
    });
    expect(await probeDrivePhoto('abc1234567', async () => response('<html>scan warning</html>', 'text/html', 'https://drive.google.com/uc'))).toMatchObject({
      status: 'not-image',
    });
    expect(
      await probeDrivePhoto('abc1234567', async () => {
        throw new Error('ECONNRESET');
      }),
    ).toMatchObject({ status: 'error', detail: 'ECONNRESET' });
  });
});

describe('survey2:photos --dry-run', () => {
  const toilet = (sourceKey: string, photoUrl: string | null, row: number) => ({
    sourceKey,
    photoUrl,
    surveys: [{ key: `${sourceKey}#t`, raw: { _row: String(row) } }],
  });
  const fw = {
    toilets: [
      toilet('survey2:TE17/male', 'https://drive.google.com/open?id=1AeW822oPhOPkYOBj9arP2-KcPnqx_HQr', 3),
      toilet('survey2:C73/female', 'https://drive.google.com/open?id=1IPYhOyWi_yGL3O0-MOqc4G6J3f4BvKBU', 2),
      toilet('survey2:C73/male', null, 4),
      toilet('survey2:H85/female', 'https://example.com/not-drive.jpg', 5),
    ],
  } as unknown as Fieldwork2024b;
  const matches = { venues: {}, attach: { 'survey2:TE17/male': { pilotToiletSourceKey: 'sheet:outram-park-tel', via: 'station-line', detail: null, locked: false } } } as Survey2Matches;

  it('plans one photo per Drive link, on the pilot toilet for attached rows', () => {
    const { items, unparsable } = planPhotos(fw, matches);
    expect(items.map((i) => [i.toiletKey, i.targetToiletKey, i.photoId])).toEqual([
      ['survey2:TE17/male', 'sheet:outram-park-tel', 'survey2-1AeW822oPhOPkYOBj9arP2-KcPnqx_HQr'],
      ['survey2:C73/female', 'survey2:C73/female', 'survey2-1IPYhOyWi_yGL3O0-MOqc4G6J3f4BvKBU'],
    ]);
    expect(unparsable).toEqual(['survey2:H85/female: https://example.com/not-drive.jpg']);
  });

  it('reports every link that needs a sign-in as not shared and stores nothing', async () => {
    const lines: string[] = [];
    const report = await runSurvey2Photos({ run: false, fetchImpl: signInFetch, fw, matches, log: (l) => lines.push(l) });
    expect(report).toMatchObject({ mode: 'dry-run', links: 3, byStatus: { 'not-shared': 2 }, stored: [] });
    expect(lines.filter((l) => l.trimStart().startsWith('row') && l.includes('not-shared'))).toHaveLength(2);
  });
});
