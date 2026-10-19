import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { StatusKindSchema, StatusReportSchema } from '../toilets/toilet.schemas.js';

export const CreateStatusSchema = z.object({
  kind: StatusKindSchema,
  /** Sent from the post-route "Was it OK?" card (GROWTH.md 1.1). Analytics only. */
  afterRoute: z.boolean().optional(),
});
export class CreateStatusDto extends createZodDto(CreateStatusSchema) {}

export class StatusReportDto extends createZodDto(z.object(StatusReportSchema.shape)) {}
export class StatusReportListDto extends createZodDto(
  z.object({ items: z.array(StatusReportSchema) }),
) {}
