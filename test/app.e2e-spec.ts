import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app.factory.js';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health reports the database up', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toMatchObject({ ok: true, db: 'up' });
    expect(new Date(res.body.time).getTime()).not.toBeNaN();
  });

  it('GET /health/live answers without the database, uncached and unthrottled', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/live')
      .expect(200);
    expect(res.body).toEqual({
      ok: true,
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
      time: expect.any(String),
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('a 4xx still answers normally through the global exception filter', async () => {
    const res = await request(app.getHttpServer())
      .get('/no-such-route')
      .expect(404);
    expect(res.body).toMatchObject({ statusCode: 404 });
  });
});
