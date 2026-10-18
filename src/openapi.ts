/** Writes openapi.json without starting the server. Run with `pnpm openapi`. */
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { buildOpenApi } from './app.factory.js';

const app = await NestFactory.create(AppModule, { logger: false });
writeFileSync('openapi.json', JSON.stringify(buildOpenApi(app), null, 2));
await app.close();
console.log('openapi.json written');
