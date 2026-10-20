import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import sharp from 'sharp';
import { env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Photo } from '../generated/prisma/client.js';
import { ALLOWED_TYPES, MAX_UPLOAD_BYTES, type PhotoRef } from './media.dto.js';
import {
  EXT_BY_TYPE,
  LocalStorage,
  S3Storage,
  type ImageType,
  type Storage,
} from './storage.js';

export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');
export const PRESIGN_EXPIRY_S = 600;
export const THUMB_WIDTH = 400;
/**
 * Decoded-size ceiling for uploads. The app resizes to 1600 px before upload (about 2.6 MP), so
 * 40 MP is generous; sharp's own default (268 MP) lets a small, highly compressed PNG decode to
 * gigabytes and exhaust the function's memory.
 */
export const MAX_INPUT_PIXELS = 40_000_000;

/** S3/R2 when bucket + keys are configured, else local files under backend/uploads. */
export function createStorageFromEnv(): Storage {
  if (env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
    return new S3Storage({
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      publicUrl: env.S3_PUBLIC_URL,
    });
  }
  return new LocalStorage(resolve(process.cwd(), 'uploads'));
}

const SHARP_FORMAT: Record<ImageType, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const thumbKeyFor = (photoId: string) => `thumbs/${photoId}.webp`;

@Injectable()
export class MediaService {
  private readonly log = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MEDIA_STORAGE) readonly storage: Storage,
  ) {}

  get isLocal(): boolean {
    return this.storage.kind === 'local';
  }

  publicUrl(key: string): string {
    return this.storage.publicUrl(key);
  }

  async deleteObject(key: string): Promise<void> {
    await this.storage.delete(key);
  }

  /** Deletes the photo's original and thumbnail objects (best effort). */
  async deletePhotoObjects(photo: Pick<Photo, 'id' | 'key'>): Promise<void> {
    for (const key of [photo.key, thumbKeyFor(photo.id)]) {
      try {
        await this.storage.delete(key);
      } catch (e) {
        this.log.warn(`Failed to delete ${key}: ${(e as Error).message}`);
      }
    }
  }

  /** `size` (the declared byte count, <= 5 MB) is signed into the URL, so R2 refuses any other length. */
  async presign(userId: string, contentType: ImageType, size?: number) {
    const id = randomUUID();
    const key = `tmp/${userId}/${id}.${EXT_BY_TYPE[contentType]}`;
    const uploadUrl = this.isLocal
      ? `/api/media/${id}/upload`
      : await this.storage.presignPut(key, contentType, PRESIGN_EXPIRY_S, size);
    await this.prisma.photo.create({
      data: { id, key, url: '', contentType, uploadedById: userId },
    });
    return {
      photoId: id,
      uploadUrl,
      method: 'PUT' as const,
      headers: { 'Content-Type': contentType },
    };
  }

  private async ownPhoto(userId: string, photoId: string): Promise<Photo> {
    const photo = await this.prisma.photo.findUnique({ where: { id: photoId } });
    if (!photo || photo.uploadedById !== userId) throw new NotFoundException('Photo not found');
    return photo;
  }

  /** Dev fallback for the presigned PUT. */
  async uploadLocal(userId: string, photoId: string, contentType: string | undefined, body: Buffer) {
    if (!this.isLocal) throw new NotFoundException();
    const photo = await this.ownPhoto(userId, photoId);
    if (photo.confirmed) throw new BadRequestException('Photo already confirmed');
    const type = contentType?.split(';')[0].trim().toLowerCase();
    if (type !== photo.contentType) {
      throw new UnsupportedMediaTypeException(`Content-Type must be ${photo.contentType}`);
    }
    if (body.length === 0) throw new BadRequestException('Empty body');
    if (body.length > MAX_UPLOAD_BYTES) throw new PayloadTooLargeException('Max 5 MB');
    await this.storage.put(photo.key, body, photo.contentType);
  }

  /**
   * Verifies the uploaded object, re-encodes it (auto-rotate, strips EXIF incl. GPS) to
   * photos/<id>.<ext>, writes a 400px webp thumbnail to thumbs/<id>.webp and marks it confirmed.
   * The tmp/ object is removed; anything left there is cleaned by the bucket lifecycle rule.
   */
  async confirm(userId: string, photoId: string): Promise<PhotoRef> {
    const photo = await this.ownPhoto(userId, photoId);
    if (photo.confirmed) return toPhotoRef(photo);
    const type = photo.contentType as ImageType;
    if (!(ALLOWED_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException('Unsupported content type');
    }

    const head = await this.storage.head(photo.key);
    if (!head) throw new BadRequestException('Upload not found. PUT the file to uploadUrl first.');
    if (head.size > MAX_UPLOAD_BYTES) {
      await this.discardTmp(photo.key);
      throw new PayloadTooLargeException('Max 5 MB');
    }
    if (head.contentType && head.contentType.split(';')[0].trim() !== type) {
      await this.discardTmp(photo.key);
      throw new BadRequestException(`Uploaded Content-Type must be ${type}`);
    }

    const original = await this.storage.get(photo.key);
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
      meta = await sharp(original, { limitInputPixels: false }).metadata(); // header only; size checked below
    } catch {
      await this.discardTmp(photo.key);
      throw new BadRequestException('File is not a valid image');
    }
    if (meta.format !== SHARP_FORMAT[type]) {
      await this.discardTmp(photo.key);
      throw new BadRequestException(`File content is ${meta.format ?? 'unknown'}, expected ${type}`);
    }
    if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_INPUT_PIXELS) {
      await this.discardTmp(photo.key);
      throw new BadRequestException('Image dimensions are too large');
    }

    // A valid header does not guarantee decodable pixel data (truncated/corrupt uploads),
    // so decoding failures are the client's fault: 400, not 500.
    let full: Buffer;
    let thumb: Buffer;
    try {
      const base = sharp(original, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();
      full =
        type === 'image/jpeg'
          ? await base.clone().jpeg({ quality: 85 }).toBuffer()
          : type === 'image/png'
            ? await base.clone().png().toBuffer()
            : await base.clone().webp({ quality: 85 }).toBuffer();
      thumb = await base
        .clone()
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();
    } catch {
      await this.discardTmp(photo.key);
      throw new BadRequestException('Image is corrupt or truncated and could not be processed');
    }

    const finalKey = `photos/${photo.id}.${EXT_BY_TYPE[type]}`;
    const thumbKey = thumbKeyFor(photo.id);
    await this.storage.put(finalKey, full, type);
    await this.storage.put(thumbKey, thumb, 'image/webp');
    await this.discardTmp(photo.key);

    const updated = await this.prisma.photo.update({
      where: { id: photo.id },
      data: {
        key: finalKey,
        url: this.storage.publicUrl(finalKey),
        thumbUrl: this.storage.publicUrl(thumbKey),
        confirmed: true,
      },
    });
    return toPhotoRef(updated);
  }

  private async discardTmp(key: string) {
    try {
      await this.storage.delete(key);
    } catch (e) {
      this.log.warn(`Failed to delete ${key}: ${(e as Error).message}`);
    }
  }
}

export function toPhotoRef(p: Pick<Photo, 'id' | 'url' | 'thumbUrl'>): PhotoRef {
  return { id: p.id, url: p.url, thumbUrl: p.thumbUrl };
}
