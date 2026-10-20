import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/nestjs';
import { waitUntil } from '@vercel/functions';
import { shouldReport } from './sentry.js';

/** How long a reported error may keep a frozen-after-response Vercel function alive. */
const FLUSH_TIMEOUT_MS = 2_000;

/**
 * Global catch-all registered in AppModule. Reports unexpected errors and 5xx to Sentry (4xx are
 * not), then hands over to Nest's default handler, so responses and logs are unchanged.
 *
 * Replaces Sentry's own SentryGlobalFilter, which skips every HttpException including 5xx ones
 * (e.g. the 503 from /health when the database is down).
 */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (Sentry.isInitialized() && shouldReport(exception)) {
      Sentry.captureException(exception, {
        mechanism: { handled: false, type: 'auto.http.nestjs.global_filter' },
      });
      // Vercel freezes the function once the response is sent; keep it alive until the event is out.
      waitUntil(Sentry.flush(FLUSH_TIMEOUT_MS));
    }
    super.catch(exception, host);
  }
}
