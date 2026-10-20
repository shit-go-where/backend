/**
 * Sentry init. Imported first by main.ts so the SDK is set up before Nest loads. Nothing happens
 * without SENTRY_DSN (local dev, tests, `pnpm openapi`, the CLI).
 */
import * as Sentry from '@sentry/nestjs';
import { env } from './config/env.js';
import { sentryOptions } from './observability/sentry.js';

if (env.SENTRY_DSN) {
  Sentry.init(sentryOptions(process.env, env.SENTRY_DSN));
}
