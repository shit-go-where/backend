import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module.js';
import { env } from './config/env.js';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.use(cookieParser());
  // In production the browser reaches the API through the Next /api rewrite (same origin),
  // so CORS only matters for local tools and Swagger UI.
  app.enableCors({ origin: env.FRONTEND_ORIGIN, credentials: true });
  app.enableShutdownHooks();
  SwaggerModule.setup('docs', app, buildOpenApi(app), { jsonDocumentUrl: 'openapi.json' });
  return app;
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Shit Go Where API')
    .setDescription('Find, rate and route to toilets in Singapore.')
    .setVersion('1.0.0')
    .setOpenAPIVersion('3.1.0')
    .addCookieAuth('sgw_session')
    .build();
  return cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
}
