import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const sent: { cmd: string; input: Record<string, unknown> }[] = [];
const objects = new Map<string, { body: Buffer; type: string }>();

vi.mock('@aws-sdk/client-s3', () => {
  const cmd = (name: string) =>
    class {
      readonly name = name;
      constructor(readonly input: Record<string, unknown>) {}
    };
  class S3Client {
    constructor(readonly config: unknown) {}
    async send(c: { name: string; input: Record<string, unknown> }) {
      sent.push({ cmd: c.name, input: c.input });
      const key = c.input.Key as string;
      switch (c.name) {
        case 'HeadObject': {
          const o = objects.get(key);
          if (!o) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
          return { ContentLength: o.body.length, ContentType: o.type };
        }
        case 'GetObject': {
          const o = objects.get(key)!;
          return { Body: { transformToByteArray: async () => new Uint8Array(o.body) } };
        }
        case 'PutObject':
          objects.set(key, { body: c.input.Body as Buffer, type: c.input.ContentType as string });
          return {};
        case 'DeleteObject':
          objects.delete(key);
          return {};
      }
      return {};
    }
  }
  return {
    S3Client,
    HeadObjectCommand: cmd('HeadObject'),
    GetObjectCommand: cmd('GetObject'),
    PutObjectCommand: cmd('PutObject'),
    DeleteObjectCommand: cmd('DeleteObject'),
  };
});
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(
    async (
      _c: unknown,
      command: { name: string; input: Record<string, unknown> },
      opts: { expiresIn: number; signingDate?: Date },
    ) =>
      `https://acct.r2.cloudflarestorage.com/bucket/${String(command.input.Key)}?op=${command.name}` +
      `&X-Amz-Date=${(opts.signingDate ?? new Date()).toISOString()}&X-Amz-Expires=${opts.expiresIn}&X-Amz-Signature=sig`,
  ),
}));

const { MediaService } = await import('./media.service.js');
const { LocalStorage, S3Storage } = await import('./storage.js');

function fakePrisma() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    photo: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { thumbUrl: null, confirmed: false, approved: false, approvals: 0, submission: null, ...data };
        rows.set(data.id as string, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        const row = { ...rows.get(where.id), ...data };
        rows.set(where.id, row);
        return row;
      }),
    },
  };
}

const jpeg = (w = 1200, h = 800) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#3a7' } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: 'secret-gps-ish' } } })
    .toBuffer();

describe('MediaService with S3 (mocked R2)', () => {
  beforeEach(() => {
    sent.length = 0;
    objects.clear();
  });

  const storage = () =>
    new S3Storage({
      bucket: 'bucket',
      accessKeyId: 'k',
      secretAccessKey: 's',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      region: 'auto',
    });

  it('configures the client for R2', () => {
    const s = storage();
    expect((s.client as unknown as { config: Record<string, unknown> }).config).toMatchObject({
      region: 'auto',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
    });
  });

  it('presigns a PUT under tmp/<user>/ and creates an unconfirmed Photo', async () => {
    const prisma = fakePrisma();
    const svc = new MediaService(prisma as never, storage());
    const r = await svc.presign('user1', 'image/jpeg');
    expect(r.method).toBe('PUT');
    expect(r.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(r.uploadUrl).toContain(`/tmp/user1/${r.photoId}.jpg`);
    expect(prisma.rows.get(r.photoId)).toMatchObject({
      key: `tmp/user1/${r.photoId}.jpg`,
      contentType: 'image/jpeg',
      confirmed: false,
      approved: false,
    });
  });

  it('signs the declared size into the presigned PUT', async () => {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const svc = new MediaService(fakePrisma() as never, storage());
    await svc.presign('user1', 'image/jpeg', 123_456);
    const [, command, opts] = vi.mocked(getSignedUrl).mock.calls.at(-1) as unknown as [
      unknown,
      { input: Record<string, unknown> },
      { signableHeaders: Set<string> },
    ];
    expect(command.input).toMatchObject({ ContentType: 'image/jpeg', ContentLength: 123_456 });
    expect([...opts.signableHeaders].sort()).toEqual(['content-length', 'content-type']);
  });

  it('rejects an image whose decoded size is over the pixel cap (decompression bomb)', async () => {
    const prisma = fakePrisma();
    const svc = new MediaService(prisma as never, storage());
    const { photoId } = await svc.presign('user1', 'image/png');
    // 8000 x 6000 = 48 MP of one colour: a few hundred KB as PNG, 192 MB once decoded.
    const bomb = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#000' } }).png().toBuffer();
    objects.set(`tmp/user1/${photoId}.png`, { body: bomb, type: 'image/png' });
    await expect(svc.confirm('user1', photoId)).rejects.toThrow('Image dimensions are too large');
    expect(objects.has(`tmp/user1/${photoId}.png`)).toBe(false);
  });

  it('confirm moves to photos/, writes a 400px webp thumb and strips EXIF', async () => {
    const prisma = fakePrisma();
    const svc = new MediaService(prisma as never, storage());
    const { photoId } = await svc.presign('user1', 'image/jpeg');
    objects.set(`tmp/user1/${photoId}.jpg`, { body: await jpeg(), type: 'image/jpeg' });

    const ref = await svc.confirm('user1', photoId);
    // API read paths, never bucket URLs: the bucket is private.
    expect(ref).toEqual({
      id: photoId,
      url: `/api/media/photos/${photoId}`,
      thumbUrl: `/api/media/photos/${photoId}/thumb`,
    });
    expect(objects.has(`tmp/user1/${photoId}.jpg`)).toBe(false);
    const thumb = await sharp(objects.get(`thumbs/${photoId}.webp`)!.body).metadata();
    expect(thumb).toMatchObject({ format: 'webp', width: 400 });
    const full = await sharp(objects.get(`photos/${photoId}.jpg`)!.body).metadata();
    expect(full.exif).toBeUndefined();
    expect(prisma.rows.get(photoId)).toMatchObject({ confirmed: true, key: `photos/${photoId}.jpg` });
    // idempotent
    expect(await svc.confirm('user1', photoId)).toEqual(ref);
  });

  it('confirm rejects missing, oversize, wrong-type and other users', async () => {
    const prisma = fakePrisma();
    const svc = new MediaService(prisma as never, storage());
    const { photoId } = await svc.presign('user1', 'image/png');
    await expect(svc.confirm('user1', photoId)).rejects.toThrow(/Upload not found/);
    await expect(svc.confirm('user2', photoId)).rejects.toThrow(/not found/);

    objects.set(`tmp/user1/${photoId}.png`, { body: Buffer.alloc(5_000_001), type: 'image/png' });
    await expect(svc.confirm('user1', photoId)).rejects.toThrow(/5 MB/);

    objects.set(`tmp/user1/${photoId}.png`, { body: await jpeg(10, 10), type: 'image/png' });
    await expect(svc.confirm('user1', photoId)).rejects.toThrow(/expected image\/png/);
    expect(prisma.rows.get(photoId)?.confirmed).toBe(false);
  });
});

const user = (id: string, role: 'USER' | 'TRUSTED' | 'MODERATOR' | 'ADMIN' = 'USER') =>
  ({ id, role }) as never;

describe('MediaService.readPhoto with S3 (private bucket)', () => {
  const s3 = () =>
    new S3Storage({
      bucket: 'bucket',
      accessKeyId: 'k',
      secretAccessKey: 's',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      region: 'auto',
    });
  const NOW = Date.parse('2026-10-20T10:17:30Z');

  function setup(row: Record<string, unknown>) {
    const prisma = fakePrisma();
    prisma.rows.set('p1', {
      id: 'p1',
      key: 'photos/p1.jpg',
      thumbUrl: '/api/media/photos/p1/thumb',
      confirmed: true,
      approved: true,
      uploadedById: 'owner',
      submission: null,
      ...row,
    });
    return new MediaService(prisma as never, s3());
  }

  it('approved: anyone gets a 302 to a GET signed for the hour window, cacheable until it ends', async () => {
    const svc = setup({});
    const read = await svc.readPhoto(null, 'p1', 'full', NOW);
    expect(read).toEqual({
      kind: 'redirect',
      url:
        'https://acct.r2.cloudflarestorage.com/bucket/photos/p1.jpg?op=GetObject' +
        '&X-Amz-Date=2026-10-20T10:00:00.000Z&X-Amz-Expires=7200&X-Amz-Signature=sig',
      // 10:17:30 -> the window ends at 11:00:00: 42.5 min = 2550 s.
      cacheControl: 'public, max-age=2550, s-maxage=2550',
    });
    // Same window, same URL (the browser's image cache keeps working).
    const later = await svc.readPhoto(user('someone'), 'p1', 'full', NOW + 20 * 60_000);
    expect(later.kind === 'redirect' && later.url).toBe(read.kind === 'redirect' && read.url);
  });

  it('thumb reads thumbs/<id>.webp; 404 when the row has no thumbnail', async () => {
    const read = await setup({}).readPhoto(null, 'p1', 'thumb', NOW);
    expect(read.kind === 'redirect' && read.url).toContain('/bucket/thumbs/p1.webp?');
    await expect(setup({ thumbUrl: null }).readPhoto(null, 'p1', 'thumb', NOW)).rejects.toThrow(/not found/i);
  });

  it('pending: uploader and TRUSTED+ only, short window, never cached', async () => {
    const svc = setup({ approved: false });
    await expect(svc.readPhoto(null, 'p1', 'full', NOW)).rejects.toThrow(/not found/i);
    await expect(svc.readPhoto(user('stranger'), 'p1', 'full', NOW)).rejects.toThrow(/not found/i);
    const own = await svc.readPhoto(user('owner'), 'p1', 'full', NOW);
    expect(own).toMatchObject({ kind: 'redirect', cacheControl: 'private, no-store' });
    // 10:17:30 -> 5-minute window starting 10:15:00, valid 10 minutes.
    expect(own.kind === 'redirect' && own.url).toContain('X-Amz-Date=2026-10-20T10:15:00.000Z&X-Amz-Expires=600');
    for (const role of ['TRUSTED', 'MODERATOR', 'ADMIN'] as const) {
      await expect(svc.readPhoto(user('mod', role), 'p1', 'full', NOW)).resolves.toMatchObject({ kind: 'redirect' });
    }
  });

  it('pending on a submission: any signed-in reviewer while it is open and not flagged', async () => {
    const open = setup({ approved: false, submission: { state: 'PENDING', resolution: null } });
    await expect(open.readPhoto(user('reviewer'), 'p1', 'full', NOW)).resolves.toMatchObject({ kind: 'redirect' });
    await expect(open.readPhoto(null, 'p1', 'full', NOW)).rejects.toThrow(/not found/i);
    const flagged = setup({ approved: false, submission: { state: 'ESCALATED', resolution: 'escalated_flagged' } });
    await expect(flagged.readPhoto(user('reviewer'), 'p1', 'full', NOW)).rejects.toThrow(/not found/i);
    const decided = setup({ approved: false, submission: { state: 'REJECTED', resolution: 'rejected_votes' } });
    await expect(decided.readPhoto(user('reviewer'), 'p1', 'full', NOW)).rejects.toThrow(/not found/i);
    await expect(decided.readPhoto(user('owner'), 'p1', 'full', NOW)).resolves.toMatchObject({ kind: 'redirect' });
  });

  it('never signs raw uploads: unconfirmed rows and tmp/ keys are 404 for everyone, uploader included', async () => {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    vi.mocked(getSignedUrl).mockClear();
    const unconfirmed = setup({ confirmed: false, approved: false, key: 'tmp/owner/p1.jpg' });
    await expect(unconfirmed.readPhoto(user('owner'), 'p1', 'full', NOW)).rejects.toThrow(/not found/i);
    await expect(unconfirmed.readPhoto(user('a', 'ADMIN'), 'p1', 'full', NOW)).rejects.toThrow(/not found/i);
    const odd = setup({ key: 'tmp/owner/p1.jpg' });
    await expect(odd.readPhoto(null, 'p1', 'full', NOW)).rejects.toThrow(/not found/i);
    await expect(setup({}).readPhoto(null, 'nope', 'full', NOW)).rejects.toThrow(/not found/i);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});

describe('MediaService with local storage (real files)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sgw-media-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads through the API, confirms, and reads back through the access-checked route', async () => {
    const prisma = fakePrisma();
    const local = new LocalStorage(dir);
    const svc = new MediaService(prisma as never, local);
    const r = await svc.presign('u', 'image/jpeg');
    expect(r.uploadUrl).toBe(`/api/media/${r.photoId}/upload`);

    await expect(svc.uploadLocal('u', r.photoId, 'image/png', Buffer.from('x'))).rejects.toThrow(
      /Content-Type/,
    );
    await svc.uploadLocal('u', r.photoId, 'image/jpeg', await jpeg(300, 200));
    const ref = await svc.confirm('u', r.photoId);
    expect(ref.url).toBe(`/api/media/photos/${r.photoId}`);
    expect(ref.thumbUrl).toBe(`/api/media/photos/${r.photoId}/thumb`);
    const thumb = await sharp(await readFile(join(dir, 'thumbs', `${r.photoId}.webp`))).metadata();
    expect(thumb.width).toBe(300); // never enlarged
    expect(await local.head(`tmp/u/${r.photoId}.jpg`)).toBeNull();

    // Pending: the uploader gets the file (never cached), strangers a 404.
    const own = await svc.readPhoto(user('u'), r.photoId, 'thumb');
    expect(own).toEqual({
      kind: 'file',
      path: join(dir, 'thumbs', `${r.photoId}.webp`),
      contentType: 'image/webp',
      cacheControl: 'private, no-store',
    });
    await expect(svc.readPhoto(null, r.photoId, 'full')).rejects.toThrow(/not found/i);
    prisma.rows.get(r.photoId)!.approved = true;
    const pub = await svc.readPhoto(null, r.photoId, 'full');
    expect(pub).toMatchObject({ kind: 'file', path: join(dir, 'photos', `${r.photoId}.jpg`), contentType: 'image/jpeg' });
    expect(pub.cacheControl).toMatch(/^public, max-age=\d+, s-maxage=\d+$/);

    await svc.deletePhotoObjects({ id: r.photoId, key: `photos/${r.photoId}.jpg` });
    expect(await local.head(`photos/${r.photoId}.jpg`)).toBeNull();
    expect(await local.head(`thumbs/${r.photoId}.webp`)).toBeNull();
  });

  it('refuses unsafe keys', () => {
    const local = new LocalStorage(dir);
    expect(() => local.path('../etc/passwd')).toThrow();
    expect(() => local.path('photos/../../x.jpg')).toThrow();
    expect(() => local.path('other/x.jpg')).toThrow();
  });
});
