import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: optional,
  FRONTEND_ORIGIN: z.string().default('http://localhost:3000'),
  /** Origin the browser uses (frontend). OAuth redirect = PUBLIC_APP_URL + /api/auth/callback */
  PUBLIC_APP_URL: z.string().default('http://localhost:3000'),
  AUTH_SECRET: z.string().min(16),
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  ONEMAP_EMAIL: optional,
  ONEMAP_PASSWORD: optional,
  S3_ENDPOINT: optional,
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: optional,
  S3_PUBLIC_URL: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  CRON_SECRET: optional,
  DEV_LOGIN_ENABLED: bool,
  SENTRY_DSN: optional,
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.DEV_LOGIN_ENABLED) {
    throw new Error('DEV_LOGIN_ENABLED must not be set in production');
  }
  return parsed.data;
}

export const env = loadEnv();
