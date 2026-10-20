// Must stay the first import: Sentry is set up before anything else loads (no-op without SENTRY_DSN).
import './instrument.js';
// Vercel's NestJS builder detects the entrypoint by this import; keep it.
import '@nestjs/core';
import { createApp } from './app.factory.js';
import { env } from './config/env.js';

// No top-level await here: Vercel's NestJS runtime intercepts listen() and waits for this module
// to finish evaluating, so awaiting listen() at module level deadlocks cold starts.
async function bootstrap() {
  const app = await createApp();
  await app.listen(env.PORT);
  console.log(`API on http://localhost:${env.PORT} (docs at /docs)`);
}

bootstrap().catch((err: unknown) => {
  console.error('Failed to start API', err);
  process.exit(1);
});
