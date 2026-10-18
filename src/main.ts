// Vercel's NestJS builder detects the entrypoint by this import; keep it.
import '@nestjs/core';
import { createApp } from './app.factory.js';
import { env } from './config/env.js';

const app = await createApp();
await app.listen(env.PORT);
console.log(`API on http://localhost:${env.PORT} (docs at /docs)`);
