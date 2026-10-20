import { S3Storage } from './storage.js';

/** The real AWS SDK presigner (no mocks): what the browser is redirected to. */
describe('S3Storage.presignGet (real signer)', () => {
  const r2 = new S3Storage({
    bucket: 'sgw-photos',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    region: 'auto',
  });
  const at = new Date('2026-10-20T10:00:00Z');

  it('signs a plain path-style GET with the given date and expiry', async () => {
    const url = new URL(await r2.presignGet('photos/p1.jpg', 7200, at));
    expect(`${url.origin}${url.pathname}`).toBe('https://acct.r2.cloudflarestorage.com/sgw-photos/photos/p1.jpg');
    const q = url.searchParams;
    expect(q.get('X-Amz-Date')).toBe('20261020T100000Z');
    expect(q.get('X-Amz-Expires')).toBe('7200');
    expect(q.get('X-Amz-SignedHeaders')).toBe('host');
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    // A browser <img> cannot send extra headers, and checksum mode is off (responseChecksumValidation).
    expect(q.has('x-amz-checksum-mode')).toBe(false);
  });

  it('is deterministic for the same key, date and expiry, and differs by key', async () => {
    const a = await r2.presignGet('photos/p1.jpg', 7200, at);
    expect(await r2.presignGet('photos/p1.jpg', 7200, at)).toBe(a);
    expect(await r2.presignGet('thumbs/p1.webp', 7200, at)).not.toBe(a);
  });

  it('uses virtual-hosted AWS S3 when no endpoint is set', async () => {
    const aws = new S3Storage({ bucket: 'sgw-photos', accessKeyId: 'k', secretAccessKey: 's', region: 'ap-southeast-1' });
    const url = new URL(await aws.presignGet('photos/p1.jpg', 60, at));
    expect(url.host).toBe('sgw-photos.s3.ap-southeast-1.amazonaws.com');
    expect(url.pathname).toBe('/photos/p1.jpg');
  });
});
