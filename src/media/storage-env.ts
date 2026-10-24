import { resolve } from 'node:path';
import { env } from '../config/env.js';
import { LocalStorage, S3Storage, type Storage } from './storage.js';

/**
 * S3/R2 when bucket + keys are configured, else local files under backend/uploads. Kept out of
 * media.service.ts so the CLI (`survey2:photos`) can use it without loading Nest.
 */
export function createStorageFromEnv(): Storage {
  if (env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
    return new S3Storage({
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
    });
  }
  return new LocalStorage(resolve(process.cwd(), 'uploads'));
}
