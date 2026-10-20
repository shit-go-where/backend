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
  getSignedUrl: vi.fn(async (_c: unknown, command: { input: Record<string, unknown> }) =>
    `https://acct.r2.cloudflarestorage.com/bucket/${String(command.input.Key)}?X-Amz-Signature=sig`,
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
        const row = { thumbUrl: null, confirmed: false, approved: false, approvals: 0, ...data };
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
      publicUrl: 'https://img.example.com',
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
    expect(ref).toEqual({
      id: photoId,
      url: `https://img.example.com/photos/${photoId}.jpg`,
      thumbUrl: `https://img.example.com/thumbs/${photoId}.webp`,
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

describe('MediaService with local storage (real files)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sgw-media-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads through the API, confirms and serves under /api/media/files', async () => {
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
    expect(ref.url).toBe(`/api/media/files/photos/${r.photoId}.jpg`);
    expect(ref.thumbUrl).toBe(`/api/media/files/thumbs/${r.photoId}.webp`);
    const thumb = await sharp(await readFile(join(dir, 'thumbs', `${r.photoId}.webp`))).metadata();
    expect(thumb.width).toBe(300); // never enlarged
    expect(await local.head(`tmp/u/${r.photoId}.jpg`)).toBeNull();

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
