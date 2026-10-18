import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ReviewSchema } from '../toilets/toilet.schemas.js';

export const CreateReviewSchema = z.object({
  cleanliness: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
  photoIds: z.array(z.string().min(1)).max(10).optional(),
});
export class CreateReviewDto extends createZodDto(CreateReviewSchema) {}

export const ReviewListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export class ReviewListQueryDto extends createZodDto(ReviewListQuerySchema) {}

export class ReviewDto extends createZodDto(z.object(ReviewSchema.shape)) {}
export class ReviewPageDto extends createZodDto(
  z.object({ items: z.array(ReviewSchema), nextCursor: z.string().nullable() }),
) {}
