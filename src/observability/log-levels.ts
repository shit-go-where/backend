import type { LogLevel } from '@nestjs/common';

/**
 * Production keeps errors and warnings only (AUDIT B-24): the `log` level is just Nest's ~70
 * route-mapping lines on every cold start, which crowd Vercel's one-hour log window. No app code
 * logs at `log`, `debug` or `verbose`. Vercel sets NODE_ENV=production on previews too.
 */
export function logLevels(nodeEnv: string | undefined, vercelEnv: string | undefined): LogLevel[] {
  return nodeEnv === 'production' || vercelEnv === 'production' ? ['error', 'warn'] : ['error', 'warn', 'log'];
}
