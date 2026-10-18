import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const MAX_UPLOAD_BYTES = 5_000_000;
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const PresignSchema = z.object({
  contentType: z.enum(ALLOWED_TYPES),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});
export class PresignDto extends createZodDto(PresignSchema) {}

export const PresignResultSchema = z.object({
  photoId: z.string(),
  uploadUrl: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
});
export class PresignResultDto extends createZodDto(PresignResultSchema) {}

export const PhotoRefSchema = z.object({
  id: z.string(),
  url: z.string(),
  thumbUrl: z.string().nullable(),
});
export type PhotoRef = z.infer<typeof PhotoRefSchema>;
export class MediaPhotoRefDto extends createZodDto(PhotoRefSchema) {}
