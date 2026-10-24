import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app.factory.js';
import { areaSlug, regionOf } from '../src/areas/regions.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { resetDb, seedFinder, type FinderFixture } from './fixtures/finder.js';

describe('Areas (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: FinderFixture;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    prisma = app.get(PrismaService);
    fx = await seedFinder(prisma);
    // Put the "no toilet" venues in Bishan too, so the area page has to list them.
    await prisma.venue.updateMany({
      where: { id: { in: [fx.venues.noToilet.id, fx.venues.usesNearby.id] } },
      data: { planningArea: 'BISHAN' },
    });
  });

  afterAll(async () => {
    if (prisma) await resetDb(prisma);
    await app?.close();
  });

  it('slugs and regions', () => {
    expect(areaSlug('Downtown Core')).toBe('downtown-core');
    expect(areaSlug('North-Eastern Islands')).toBe('north-eastern-islands');
    expect(regionOf('TOA PAYOH')).toBe('CENTRAL');
    expect(regionOf('Tampines')).toBe('EAST');
    expect(regionOf('Atlantis')).toBeNull();
  });

  it('GET /areas counts ACTIVE toilets per area and flags thin ones', async () => {
    const res = await http().get('/areas').expect(200);
    expect(res.body.items).toEqual([
      {
        slug: 'bishan', name: 'BISHAN', region: 'CENTRAL',
        // a1, a2, b1. Not the pending one, the renovating one, or c1 at a NONE venue.
        toiletCount: 3, verifiedCount: 1, venueCount: 2, indexable: true,
      },
      {
        slug: 'toa-payoh', name: 'TOA PAYOH', region: 'CENTRAL',
        toiletCount: 1, verifiedCount: 0, venueCount: 1, indexable: false,
      },
    ]);
  });

  it('GET /areas/:slug groups toilets by place, best first', async () => {
    const res = await http().get('/areas/bishan').expect(200);
    const b = res.body;
    expect(b).toMatchObject({ slug: 'bishan', name: 'BISHAN', toiletCount: 3, pendingCount: 1, indexable: true });
    expect(b.venues.map((v: { id: string }) => v.id)).toEqual([fx.venues.mall.id, fx.venues.station.id]);
    // Open first, verified before community; the renovating toilet stays listed, last.
    expect(b.venues[0].toilets.map((t: { id: string }) => t.id)).toEqual([
      fx.toilets.a1.id,
      fx.toilets.a2.id,
      fx.toilets.closed.id,
    ]);
    expect(b.venues[0]).toMatchObject({ address: '1 Test Road', near: null });
    // No address: point at the closest named place instead.
    expect(b.venues[1].near).toMatchObject({ name: 'Bishan CCL Test', type: 'MRT_STATION' });
    expect(b.venues[1].near.distanceM).toBeGreaterThan(600);
    expect(b.venues[1].near.distanceM).toBeLessThan(660);
    expect(b.noToiletVenues.map((v: { name: string }) => v.name)).toEqual(['Bishan CCL Test', 'Nearby User Test']);
    expect(b.center).toEqual({ lat: expect.any(Number), lng: expect.any(Number) });
    const ids = b.venues.flatMap((v: { toilets: { id: string }[] }) => v.toilets.map((t) => t.id));
    expect(ids).not.toContain(fx.toilets.pending.id);
    expect(ids).not.toContain(fx.toilets.c1.id);
  });

  it('GET /areas/:slug?sex=MALE leaves out toilets only for women', async () => {
    const res = await http().get('/areas/bishan?sex=MALE').expect(200);
    expect(res.body.toiletCount).toBe(2);
    expect(res.body.venues[0].toilets.map((t: { id: string }) => t.id)).toEqual([fx.toilets.a1.id, fx.toilets.closed.id]);
  });

  it('GET /areas/:slug resolves multi-word slugs and 404s unknown ones', async () => {
    const res = await http().get('/areas/toa-payoh').expect(200);
    expect(res.body.venues[0].toilets[0].id).toBe(fx.toilets.e1.id);
    await http().get('/areas/atlantis').expect(404);
  });

  it('GET /toilets/sitemap lists public toilet pages only', async () => {
    const res = await http().get('/toilets/sitemap').expect(200);
    const ids = res.body.items.map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining([fx.toilets.a1.id, fx.toilets.closed.id, fx.toilets.e1.id]));
    expect(ids).not.toContain(fx.toilets.pending.id);
    expect(ids).not.toContain(fx.toilets.c1.id);
    expect(res.body.items[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
