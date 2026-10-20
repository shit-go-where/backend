import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface ObjectHead {
  size: number;
  contentType: string | undefined;
}

/** Minimal object-store surface used by MediaService. Keys look like `photos/<id>.jpg`. */
export interface Storage {
  readonly kind: 's3' | 'local';
  /** `size`, when given, is signed into the URL: the upload must be exactly that many bytes. */
  presignPut(key: string, contentType: string, expiresInS: number, size?: number): Promise<string>;
  head(key: string): Promise<ObjectHead | null>;
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
}

export interface S3Config {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  region: string;
  publicUrl?: string;
}

const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';

export class S3Storage implements Storage {
  readonly kind = 's3' as const;
  readonly client: S3Client;

  constructor(private readonly cfg: S3Config) {
    this.client = new S3Client({
      // Cloudflare R2 when an endpoint is given; AWS S3 otherwise.
      region: cfg.endpoint ? 'auto' : cfg.region === 'auto' ? 'ap-southeast-1' : cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: Boolean(cfg.endpoint),
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  presignPut(key: string, contentType: string, expiresInS: number, size?: number): Promise<string> {
    const cmd = new PutObjectCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      ContentType: contentType,
      // Without a signed length the URL accepted any size (up to the store's 5 GB PUT limit).
      ...(size !== undefined ? { ContentLength: size } : {}),
    });
    return getSignedUrl(this.client, cmd, {
      expiresIn: expiresInS,
      signableHeaders: new Set(size !== undefined ? ['content-type', 'content-length'] : ['content-type']),
    });
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType };
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async get(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    if (!r.Body) throw new Error(`Empty body for ${key}`);
    return Buffer.from(await r.Body.transformToByteArray());
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: CACHE_IMMUTABLE,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }

  publicUrl(key: string): string {
    if (this.cfg.publicUrl) return `${this.cfg.publicUrl.replace(/\/$/, '')}/${key}`;
    const ep = (this.cfg.endpoint ?? `https://s3.${this.cfg.region}.amazonaws.com`).replace(/\/$/, '');
    return `${ep}/${this.cfg.bucket}/${key}`;
  }
}

const SAFE_KEY = /^(tmp|photos|thumbs)\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(jpg|png|webp)$/;

/** True for keys the local store will read/serve (no traversal, known prefixes only). */
export function isSafeKey(key: string): boolean {
  return SAFE_KEY.test(key);
}

/** Dev fallback: files under backend/uploads, served by the API at /media/files/<key>. */
export class LocalStorage implements Storage {
  readonly kind = 'local' as const;
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  path(key: string): string {
    if (!isSafeKey(key)) throw new Error(`Unsafe storage key: ${key}`);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error(`Unsafe storage key: ${key}`);
    return p;
  }

  presignPut(key: string): Promise<string> {
    throw new Error(`LocalStorage cannot presign ${key}`);
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const s = await stat(this.path(key));
      return { size: s.size, contentType: contentTypeForKey(key) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async put(key: string, body: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  publicUrl(key: string): string {
    // Through the Next /api rewrite.
    return `/api/media/files/${key}`;
  }
}

export const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
export type ImageType = keyof typeof EXT_BY_TYPE;

export function contentTypeForKey(key: string): string | undefined {
  const ext = key.slice(key.lastIndexOf('.') + 1);
  return (Object.keys(EXT_BY_TYPE) as ImageType[]).find((t) => EXT_BY_TYPE[t] === ext);
}
