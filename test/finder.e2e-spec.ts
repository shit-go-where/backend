import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/app.factory.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { OneMapService } from '../src/routing/onemap.service.js';
import {
  FAR_ORIGIN,
  ORIGIN,
  cookieFor,
  resetDb,
  seedFinder,
  type FinderFixture,
} from './fixtures/finder.js';

describe('Finder (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: FinderFixture;
  const http = () => request(app.getHttpServer());
  const near = `lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    prisma = app.get(PrismaService);
    // Never call the real OneMap from tests.
    const onemap = app.get(OneMapService);
    onemap.credentials = null;
    onemap.fetchFn = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('/elastic/search')) {
        return new Response(
          JSON.stringify({
            results: [
              { SEARCHVAL: 'BISHAN MRT STATION', ADDRESS: '200 BISHAN ROAD', LATITUDE: '1.35', LONGITUDE: '103.85' },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    fx = await seedFinder(prisma);
  });

  afterAll(async () => {
    if (prisma) await resetDb(prisma);
    await app?.close();
  });

  describe('GET /toilets/nearby', () => {
    it('returns ACTIVE toilets sorted by distance, excluding NONE venues and pending', async () => {
      const res = await http().get(`/toilets/nearby?${near}`).expect(200);
      const ids = res.body.items.map((t: { id: string }) => t.id);
      expect(ids).toEqual([fx.toilets.a1.id, fx.toilets.a2.id, fx.toilets.b1.id]);
      const a1 = res.body.items[0];
      expect(a1.distanceM).toBeGreaterThan(90);
      expect(a1.distanceM).toBeLessThan(110);
      expect(a1.walkSecondsEstimate).toBe(Math.round((a1.distanceM * 1.3) / 1.25));
      expect(a1.features).toEqual(['ACCESSIBLE', 'BIDET', 'TOILET_PAPER']);
      expect(a1).toMatchObject({
        surveyTotal: 40,
        rasStars: 4,
        scoreCleanliness: 8.2,
        openNow: true,
        tier: 'VERIFIED',
        venue: { name: 'Test Mall', toiletStatus: 'HAS_TOILETS' },
      });
    });

    it('includePending adds PENDING toilets', async () => {
      const res = await http().get(`/toilets/nearby?${near}&includePending=true`).expect(200);
      expect(res.body.items.map((t: { id: string }) => t.id)).toContain(fx.toilets.pending.id);
    });

    it('filters by features (all required), tier, areaType and radius', async () => {
      const f = await http().get(`/toilets/nearby?${near}&features=BIDET,ACCESSIBLE`).expect(200);
      expect(f.body.items.map((t: { id: string }) => t.id)).toEqual([fx.toilets.a1.id]);
      const none = await http().get(`/toilets/nearby?${near}&features=BIDET,SQUAT`).expect(200);
      expect(none.body.items).toEqual([]);
      const tier = await http().get(`/toilets/nearby?${near}&tier=IMPORTED,COMMUNITY`).expect(200);
      expect(tier.body.items.map((t: { id: string }) => t.id)).toEqual([fx.toilets.a2.id, fx.toilets.b1.id]);
      const area = await http().get(`/toilets/nearby?${near}&areaType=PAID_AREA`).expect(200);
      expect(area.body.items.map((t: { id: string }) => t.id)).toEqual([fx.toilets.a2.id]);
      const small = await http().get(`/toilets/nearby?${near}&radius=300`).expect(200);
      expect(small.body.items.map((t: { id: string }) => t.id)).toEqual([fx.toilets.a1.id, fx.toilets.a2.id]);
    });

    it('sex=MALE|FEMALE keeps toilets usable by that sex (own, unisex or unknown)', async () => {
      const all = await http().get(`/toilets/nearby?${near}`).expect(200);
      expect(all.body.items.map((t: { sex: string | null }) => t.sex)).toEqual([null, 'FEMALE', null]);
      const men = await http().get(`/toilets/nearby?${near}&sex=MALE`).expect(200);
      expect(men.body.items.map((t: { id: string }) => t.id)).toEqual([fx.toilets.a1.id, fx.toilets.b1.id]);
      const women = await http().get(`/toilets/nearby?${near}&sex=FEMALE`).expect(200);
      expect(women.body.items.map((t: { id: string }) => t.id)).toEqual([fx.toilets.a1.id, fx.toilets.a2.id, fx.toilets.b1.id]);
      await http().get(`/toilets/nearby?${near}&sex=UNISEX`).expect(400);
    });

    it('openNow=true drops definitely-closed toilets only', async () => {
      const res = await http().get(`/toilets/nearby?${near}&openNow=true`).expect(200);
      expect(res.body.items.map((t: { id: string }) => t.id)).toEqual([fx.toilets.a1.id, fx.toilets.b1.id]);
    });

    it('validates the query', async () => {
      await http().get('/toilets/nearby?lat=1.35').expect(400);
      await http().get(`/toilets/nearby?${near}&radius=9000`).expect(400);
      await http().get(`/toilets/nearby?${near}&features=NOPE`).expect(400);
    });
  });

  it('GET /toilets/in-bounds returns pins', async () => {
    const res = await http()
      .get('/toilets/in-bounds?minLat=1.34&maxLat=1.36&minLng=103.84&maxLng=103.86')
      .expect(200);
    const ids = res.body.items.map((p: { id: string }) => p.id).sort();
    expect(ids).toEqual([fx.toilets.a1.id, fx.toilets.a2.id, fx.toilets.b1.id].sort());
    expect(res.body.items[0]).toHaveProperty('venueType');
    expect(res.body.items[0]).toHaveProperty('hasIssue', false);
    // Level and venue, so the map can stack a building's floors (levelOrder derived when not stored yet).
    const a1 = res.body.items.find((p: { id: string }) => p.id === fx.toilets.a1.id);
    expect(a1).toMatchObject({ venueId: fx.venues.mall.id, level: 'L1', levelOrder: 1 });
    const a2 = res.body.items.find((p: { id: string }) => p.id === fx.toilets.a2.id);
    expect(a2).toMatchObject({ venueId: fx.venues.mall.id, level: 'B1', levelOrder: -1 });
    const b1 = res.body.items.find((p: { id: string }) => p.id === fx.toilets.b1.id);
    expect(b1).toMatchObject({ level: null, levelOrder: null });
    await http().get('/toilets/in-bounds?minLat=1.36&maxLat=1.34&minLng=103.84&maxLng=103.86').expect(400);
  });

  it('GET /toilets/in-bounds applies openNow and areaType like nearby', async () => {
    const box = 'minLat=1.34&maxLat=1.36&minLng=103.84&maxLng=103.86';
    const open = await http().get(`/toilets/in-bounds?${box}&openNow=true`).expect(200);
    expect(open.body.items.map((p: { id: string }) => p.id).sort()).toEqual([fx.toilets.a1.id, fx.toilets.b1.id].sort());
    const paid = await http().get(`/toilets/in-bounds?${box}&areaType=PAID_AREA`).expect(200);
    expect(paid.body.items.map((p: { id: string }) => p.id)).toEqual([fx.toilets.a2.id]);
  });

  it('GET /toilets/in-bounds labels pins with sex and applies sex like nearby', async () => {
    const box = 'minLat=1.34&maxLat=1.36&minLng=103.84&maxLng=103.86';
    const all = await http().get(`/toilets/in-bounds?${box}`).expect(200);
    expect(all.body.items.find((p: { id: string }) => p.id === fx.toilets.a2.id)).toMatchObject({ sex: 'FEMALE' });
    const men = await http().get(`/toilets/in-bounds?${box}&sex=MALE`).expect(200);
    expect(men.body.items.map((p: { id: string }) => p.id).sort()).toEqual([fx.toilets.a1.id, fx.toilets.b1.id].sort());
  });

  describe('GET /toilets/:id', () => {
    it('returns detail with survey, features, attribution', async () => {
      const res = await http().get(`/toilets/${fx.toilets.a1.id}`).expect(200);
      expect(res.body).toMatchObject({
        id: fx.toilets.a1.id,
        source: 'FIELDWORK_2024',
        attribution: null,
        surveyCount: 1,
        surveys: [{ surveyedAt: '2024-03-15T00:00:00.000Z', rubric: 'PILOT_50' }],
        latestSurvey: {
          rubric: 'PILOT_50',
          sex: 'MALE',
          total: 40,
          totalMax: 50,
          cleanliness: 8,
          items: expect.arrayContaining([{ kind: 'scale', key: 'facilities', label: 'Facilities', value: 17, min: 0, max: 20 }]),
        },
        openingHours: { type: 'always' },
        venue: { address: '1 Test Road', planningArea: 'BISHAN' },
        myReview: null,
        reviews: [],
        photos: [],
        seenBy: 1,
        // Has an address, so no "near" hint.
        near: null,
        // Live, so no open submission to review.
        openSubmissionId: null,
      });
      expect(res.body.featureDetails).toContainEqual(
        expect.objectContaining({ feature: 'SQUAT', present: false }),
      );
      expect(res.body.features).not.toContain('SQUAT');
      // The other ACTIVE toilet in the mall; pending and renovating ones are left out.
      expect(res.body.siblings).toEqual([
        { id: fx.toilets.a2.id, label: 'B1 food court', level: 'B1', levelOrder: -1, status: 'ACTIVE', sex: 'FEMALE' },
      ]);
    });

    it('attribution for OSM and data.gov sources, venue hours fallback', async () => {
      const osm = await http().get(`/toilets/${fx.toilets.b1.id}`).expect(200);
      expect(osm.body.attribution).toBe('© OpenStreetMap contributors (ODbL)');
      // The station has no address: say what it is near.
      expect(osm.body.near).toMatch(/^\d+ m from (Bishan CCL Test|Nearby User Test|Test Mall)$/);
      expect(osm.body.openNow).toBe(true);
      const gov = await http().get(`/toilets/${fx.toilets.e1.id}`).expect(200);
      expect(gov.body.attribution).toBe('Data © data.gov.sg, Singapore Open Data Licence');
      expect(gov.body.openNow).toBeNull();
    });

    it('404 for unknown id', async () => {
      await http().get('/toilets/does-not-exist').expect(404);
    });
  });

  describe('venues', () => {
    it('GET /venues/nearby includes NONE and USES_NEARBY venues', async () => {
      const res = await http().get(`/venues/nearby?${near}`).expect(200);
      const byName = Object.fromEntries(
        res.body.items.map((v: { name: string }) => [v.name, v]),
      );
      expect(byName['Bishan CCL Test']).toMatchObject({ toiletStatus: 'NONE', toiletCount: 0 });
      expect(byName['Nearby User Test']).toMatchObject({ toiletStatus: 'USES_NEARBY' });
      expect(byName['Test Mall']).toMatchObject({ toiletCount: 2 });
      expect(res.body.items[0].distanceM).toBeLessThanOrEqual(res.body.items[1].distanceM);
    });

    it('GET /venues/search orders by distance when a location is given', async () => {
      const res = await http().get(`/venues/search?q=test&${near}`).expect(200);
      expect(res.body.items.map((v: { name: string }) => v.name)).toEqual([
        'Test Mall',
        'Bishan CCL Test',
        'Nearby User Test',
        'Test Station',
      ]);
      const plain = await http().get('/venues/search?q=HAWKER').expect(200);
      expect(plain.body.items.map((v: { name: string }) => v.name)).toEqual(['Far Hawker']);
      await http().get('/venues/search?q=').expect(400);
    });

    it('GET /venues/:id lists its toilets', async () => {
      const res = await http().get(`/venues/${fx.venues.mall.id}`).expect(200);
      expect(res.body).toMatchObject({ name: 'Test Mall', address: '1 Test Road', planningArea: 'BISHAN' });
      expect(res.body.toilets).toHaveLength(4); // a1, a2, pending, renovation
      await http().get('/venues/nope').expect(404);
    });
  });

  describe('POST /routing/recommend', () => {
    it('returns top 3 with reasons, estimate routes and skipped venues', async () => {
      const res = await http().post('/routing/recommend').send(ORIGIN).expect(200);
      expect(res.body.searchedRadiusM).toBe(1500);
      // A2 is closed by its hours and is excluded; the pending one is offered, flagged as unconfirmed.
      expect(res.body.items).toHaveLength(3);
      const best = res.body.items[0];
      expect(best.toilet.id).toBe(fx.toilets.a1.id);
      expect(best.route).toBeNull();
      expect(best.walkSeconds).toBe(best.toilet.walkSecondsEstimate);
      expect(best.reasons).toEqual(
        expect.arrayContaining(['Bidet', 'Clean 8.2/10', 'Verified 2024 survey']),
      );
      expect(best.reasons[0]).toMatch(/^\d+ min walk$/);
      expect(best.score).toBeGreaterThan(res.body.items[1].score);
      expect(best.unconfirmed).toBe(false);
      // RENOVATION is never recommended, nor toilets at NONE venues. PENDING ones are, in calm mode, labelled.
      const ids = res.body.items.map((i: { toilet: { id: string } }) => i.toilet.id);
      expect(ids).not.toContain(fx.toilets.closed.id);
      expect(ids).not.toContain(fx.toilets.c1.id);
      const pending = res.body.items.find((i: { toilet: { id: string } }) => i.toilet.id === fx.toilets.pending.id);
      expect(pending).toMatchObject({ unconfirmed: true, toilet: { status: 'PENDING' } });
      expect(pending.reasons).toContain('Unconfirmed: added by the community, not yet confirmed');
      expect(pending.reasons).not.toContain('Community verified');
      // A2 is closed by its own hours: never recommended, even without openNow.
      expect(ids).not.toContain(fx.toilets.a2.id);
      expect(res.body.skippedVenues.map((v: { name: string }) => v.name)).toEqual([
        'Bishan CCL Test',
        'Nearby User Test',
      ]);
      expect(res.body.skippedVenues[0].note).toBe('No toilet in the CCL station');
    });

    it('applies hard filters', async () => {
      const res = await http()
        .post('/routing/recommend')
        .send({ ...ORIGIN, require: ['TOILET_PAPER'], openNow: true })
        .expect(200);
      expect(res.body.items.map((i: { toilet: { id: string } }) => i.toilet.id)).toEqual([fx.toilets.a1.id]);
      expect(res.body.items[0].reasons).toContain('Toilet paper');
    });

    it('sex filters candidates', async () => {
      const res = await http().post('/routing/recommend').send({ ...FAR_ORIGIN, urgent: true, sex: 'MALE' }).expect(200);
      expect(res.body.items.map((i: { toilet: { id: string } }) => i.toilet.id)).toEqual([fx.toilets.e1.id]);
      await http().post('/routing/recommend').send({ ...ORIGIN, sex: 'UNISEX' }).expect(400);
    });

    it('a purpose adds soft preferences without filtering', async () => {
      const plain = await http().post('/routing/recommend').send(ORIGIN).expect(200);
      const poo = await http().post('/routing/recommend').send({ ...ORIGIN, purpose: 'POO' }).expect(200);
      const ids = (r: typeof plain) => r.body.items.map((i: { toilet: { id: string } }) => i.toilet.id).sort();
      expect(ids(poo)).toEqual(ids(plain));
      expect(plain.body.items[0].reasons).not.toContain('Toilet paper');
      expect(poo.body.items[0].reasons).toContain('Toilet paper');
    });

    it('urgent mode widens the radius until something is found', async () => {
      const res = await http()
        .post('/routing/recommend')
        .send({ ...FAR_ORIGIN, urgent: true })
        .expect(200);
      expect(res.body.searchedRadiusM).toBe(3000);
      expect(res.body.items.map((i: { toilet: { id: string } }) => i.toilet.id)).toEqual([fx.toilets.e1.id]);
      const near800 = await http().post('/routing/recommend').send({ ...ORIGIN, urgent: true }).expect(200);
      expect(near800.body.searchedRadiusM).toBe(800);
      expect(near800.body.items[0].toilet.id).toBe(fx.toilets.a1.id);
      expect(near800.body.items.map((i: { toilet: { id: string } }) => i.toilet.id)).not.toContain(fx.toilets.a2.id);
      // Urgent mode never offers an unconfirmed toilet.
      expect(near800.body.items.map((i: { toilet: { id: string } }) => i.toilet.id)).not.toContain(fx.toilets.pending.id);
    });

    it('skips toilets with a confirmed CLOSED_NOW report', async () => {
      const r = await prisma.statusReport.create({
        data: {
          toiletId: fx.toilets.a1.id,
          userId: fx.users.u3.id,
          kind: 'CLOSED_NOW',
          confirmations: 1,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const res = await http().post('/routing/recommend').send(ORIGIN).expect(200);
      expect(res.body.items.map((i: { toilet: { id: string } }) => i.toilet.id)).not.toContain(fx.toilets.a1.id);
      await prisma.statusReport.delete({ where: { id: r.id } });
    });

    it('level: the floors to the toilet count in the minutes and the reasons', async () => {
      type Item = { toilet: { id: string }; walkSeconds: number; reasons: string[] };
      const a1Of = (body: { items: Item[] }) => body.items.find((i) => i.toilet.id === fx.toilets.a1.id)!;
      const plain = a1Of((await http().post('/routing/recommend').send(ORIGIN).expect(200)).body);
      // A1 is on L1: one floor up from B1 (there is no level 0), two floors down from L3.
      const fromB1 = a1Of((await http().post('/routing/recommend').send({ ...ORIGIN, level: 'basement 1' }).expect(200)).body);
      expect(fromB1.walkSeconds).toBe(plain.walkSeconds + 40);
      expect(fromB1.reasons[1]).toBe('1 floor up');
      const fromL3 = a1Of((await http().post('/routing/recommend').send({ ...ORIGIN, level: 'L3' }).expect(200)).body);
      expect(fromL3.walkSeconds).toBe(plain.walkSeconds + 80);
      expect(fromL3.reasons[1]).toBe('2 floors down');
      const fromL1 = a1Of((await http().post('/routing/recommend').send({ ...ORIGIN, level: 'ground' }).expect(200)).body);
      expect(fromL1.walkSeconds).toBe(plain.walkSeconds);
      expect(fromL1.reasons[1]).toBe('On your level');
      // Without a level nothing is said about floors.
      expect(plain.reasons.join(' ')).not.toMatch(/floor|level/);
      // A floor past the tallest building is a typo: treated as unknown, not 998 floors of lift.
      const from999 = a1Of((await http().post('/routing/recommend').send({ ...ORIGIN, level: '999' }).expect(200)).body);
      expect(from999.walkSeconds).toBe(plain.walkSeconds);
      expect(from999.reasons.join(' ')).not.toMatch(/floor|level/);
    });

    it('validates the body', async () => {
      await http().post('/routing/recommend').send({ lat: 'x' }).expect(400);
      await http().post('/routing/recommend').send({ ...ORIGIN, level: '' }).expect(400);
      await http().post('/routing/recommend').send({ ...ORIGIN, require: ['NOPE'] }).expect(400);
      await http().post('/routing/recommend').send({ ...ORIGIN, purpose: 'NOPE' }).expect(400);
    });
  });

  it('GET /routing/walk falls back to an estimate without OneMap credentials', async () => {
    const res = await http()
      .get(`/routing/walk?fromLat=${ORIGIN.lat}&fromLng=${ORIGIN.lng}&toLat=1.352&toLng=103.848`)
      .expect(200);
    expect(res.body.source).toBe('estimate');
    expect(res.body.polyline).toHaveLength(2);
    expect(res.body.durationS).toBeGreaterThan(0);
  });

  it('GET /geo/search proxies OneMap search', async () => {
    const res = await http().get('/geo/search?q=bishan').expect(200);
    expect(res.body.items).toEqual([
      { name: 'BISHAN MRT STATION', address: '200 BISHAN ROAD', lat: 1.35, lng: 103.85 },
    ]);
  });

  describe('status reports', () => {
    let reportId: string;

    it('takes signed-out reports; a lone anonymous closure stays unconfirmed until a second device', async () => {
      const e1 = fx.toilets.e1.id;
      const first = await http().post(`/toilets/${e1}/status`).send({ kind: 'CLOSED_NOW' }).expect(201);
      expect(first.body.unconfirmed).toBe(true);
      const device1 = ([] as string[])
        .concat(first.headers['set-cookie'] ?? [])
        .find((c) => c.startsWith('sgw_anon='))!
        .split(';')[0];
      // 1 h for signed-out reports, even CLOSED_NOW.
      expect(new Date(first.body.expiresAt).getTime() - new Date(first.body.createdAt).getTime()).toBe(3_600_000);
      let detail = await http().get(`/toilets/${e1}`).expect(200);
      expect(detail.body.activeStatus).toEqual([]);

      // Same device again: deduplicated, still unconfirmed.
      const again = await http().post(`/toilets/${e1}/status`).set('Cookie', device1).send({ kind: 'CLOSED_NOW' }).expect(201);
      expect(again.body).toMatchObject({ id: first.body.id, unconfirmed: true });
      // "Still true" stays signed-in only.
      await http().post(`/status/${first.body.id}/confirm`).set('Cookie', device1).expect(401);

      const second = await http().post(`/toilets/${e1}/status`).send({ kind: 'CLOSED_NOW' }).expect(201);
      expect(second.body.unconfirmed).toBe(false);
      const list = await http().get(`/toilets/${e1}/status`).expect(200);
      expect(list.body.items.every((r: { unconfirmed: boolean }) => !r.unconfirmed)).toBe(true);
      detail = await http().get(`/toilets/${e1}`).expect(200);
      expect(detail.body.activeStatus).toEqual([expect.objectContaining({ kind: 'CLOSED_NOW', count: 2 })]);
      await prisma.statusReport.deleteMany({ where: { toiletId: e1 } });
    });

    it('creates and de-duplicates within 30 min', async () => {
      const c1 = cookieFor(fx.users.u1.id);
      const first = await http()
        .post(`/toilets/${fx.toilets.a2.id}/status`)
        .set('Cookie', c1)
        .send({ kind: 'NO_PAPER' })
        .expect(201);
      reportId = first.body.id;
      const ttl = new Date(first.body.expiresAt).getTime() - new Date(first.body.createdAt).getTime();
      expect(ttl).toBe(2 * 3_600_000);
      const again = await http()
        .post(`/toilets/${fx.toilets.a2.id}/status`)
        .set('Cookie', c1)
        .send({ kind: 'NO_PAPER' })
        .expect(201);
      expect(again.body.id).toBe(reportId);
      await http().post(`/toilets/${fx.toilets.a2.id}/status`).set('Cookie', c1).send({ kind: 'NOPE' }).expect(400);
    });

    it('CLOSED_NOW lasts 24h', async () => {
      const res = await http()
        .post(`/toilets/${fx.toilets.b1.id}/status`)
        .set('Cookie', cookieFor(fx.users.u1.id))
        .send({ kind: 'CLOSED_NOW' })
        .expect(201);
      const ttl = new Date(res.body.expiresAt).getTime() - new Date(res.body.createdAt).getTime();
      expect(ttl).toBe(24 * 3_600_000);
    });

    it('confirm: not own, extends +1h, awards the reporter once', async () => {
      await http().post(`/status/${reportId}/confirm`).set('Cookie', cookieFor(fx.users.u1.id)).expect(400);
      const before = await prisma.statusReport.findUniqueOrThrow({ where: { id: reportId } });
      const res = await http()
        .post(`/status/${reportId}/confirm`)
        .set('Cookie', cookieFor(fx.users.u2.id))
        .expect(200);
      expect(res.body).toMatchObject({ id: reportId, confirmations: 1, confirmedByMe: true });
      expect(new Date(res.body.expiresAt).getTime()).toBe(before.expiresAt.getTime() + 3_600_000);
      const again = await http()
        .post(`/status/${reportId}/confirm`)
        .set('Cookie', cookieFor(fx.users.u2.id))
        .expect(200);
      expect(again.body.confirmations).toBe(1);
      const ledger = await prisma.pointsLedger.findMany({
        where: { userId: fx.users.u1.id, reason: 'STATUS_CONFIRMED' },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0].refId).toBe(`${reportId}:${fx.users.u2.id}`);
      await http().post('/status/nope/confirm').set('Cookie', cookieFor(fx.users.u2.id)).expect(404);
    });

    it('GET lists active reports and shows up in summaries', async () => {
      const res = await http()
        .get(`/toilets/${fx.toilets.a2.id}/status`)
        .set('Cookie', cookieFor(fx.users.u2.id))
        .expect(200);
      expect(res.body.items).toEqual([expect.objectContaining({ id: reportId, kind: 'NO_PAPER', confirmedByMe: true })]);
      const nearby = await http().get(`/toilets/nearby?${near}`).expect(200);
      const a2 = nearby.body.items.find((t: { id: string }) => t.id === fx.toilets.a2.id);
      expect(a2.activeStatus).toEqual([expect.objectContaining({ kind: 'NO_PAPER', count: 1 })]);
      const pins = await http()
        .get('/toilets/in-bounds?minLat=1.34&maxLat=1.36&minLng=103.84&maxLng=103.86')
        .expect(200);
      expect(pins.body.items.find((p: { id: string }) => p.id === fx.toilets.a2.id).hasIssue).toBe(true);
    });

    it('recommend reasons mention the active report', async () => {
      // A2 is normally closed by its hours (never recommended); open it for this check.
      const hours = { type: 'weekly', periods: [] };
      await prisma.toilet.update({ where: { id: fx.toilets.a2.id }, data: { openingHours: { type: 'always' } } });
      try {
        const res = await http()
          .post('/routing/recommend')
          .send({ ...ORIGIN, require: ['TOILET_PAPER'] })
          .expect(200);
        const a2 = res.body.items.find((i: { toilet: { id: string } }) => i.toilet.id === fx.toilets.a2.id);
        expect(a2.reasons).toContain('Reported: no paper just now');
      } finally {
        await prisma.toilet.update({ where: { id: fx.toilets.a2.id }, data: { openingHours: hours } });
      }
    });
  });

  describe('reviews', () => {
    const path = () => `/toilets/${fx.toilets.a2.id}/reviews`;

    it('requires sign-in and validates', async () => {
      await http().post(path()).send({ cleanliness: 4 }).expect(401);
      await http().post(path()).set('Cookie', cookieFor(fx.users.u1.id)).send({ cleanliness: 6 }).expect(400);
    });

    it('rejects photos that are not your own confirmed uploads', async () => {
      const c = cookieFor(fx.users.u1.id);
      await http().post(path()).set('Cookie', c).send({ cleanliness: 4, photoIds: [fx.photos.u1Unconfirmed.id] }).expect(400);
      await http().post(path()).set('Cookie', c).send({ cleanliness: 4, photoIds: [fx.photos.u2Confirmed.id] }).expect(400);
      expect(await prisma.review.count()).toBe(0);
    });

    it('creates with a photo, awards points, recomputes the score; upserts on repeat', async () => {
      const c = cookieFor(fx.users.u1.id);
      const res = await http()
        .post(path())
        .set('Cookie', c)
        .send({ cleanliness: 5, comment: 'Spotless', photoIds: [fx.photos.u1Confirmed.id] })
        .expect(201);
      expect(res.body).toMatchObject({
        cleanliness: 5,
        comment: 'Spotless',
        user: { handle: 'user_one' },
        photos: [{ id: fx.photos.u1Confirmed.id }],
      });
      const photo = await prisma.photo.findUniqueOrThrow({ where: { id: fx.photos.u1Confirmed.id } });
      expect(photo).toMatchObject({ reviewId: res.body.id, toiletId: fx.toilets.a2.id });
      const reasons = (await prisma.pointsLedger.findMany({ where: { userId: fx.users.u1.id, refId: res.body.id } }))
        .map((p) => p.reason)
        .sort();
      expect(reasons).toEqual(['REVIEW_POSTED', 'REVIEW_WITH_PHOTO']);
      const toilet = await prisma.toilet.findUniqueOrThrow({ where: { id: fx.toilets.a2.id } });
      expect(toilet.reviewCount).toBe(1);
      expect(toilet.scoreCleanliness).toBe(10); // only data point: 5/5 -> 10

      const again = await http().post(path()).set('Cookie', c).send({ cleanliness: 3 }).expect(201);
      expect(again.body.id).toBe(res.body.id);
      expect(again.body.photos).toHaveLength(1); // photoIds omitted keeps photos
      expect(await prisma.review.count({ where: { toiletId: fx.toilets.a2.id } })).toBe(1);
      expect(await prisma.pointsLedger.count({ where: { userId: fx.users.u1.id, refId: res.body.id } })).toBe(2);
    });

    it('lists reviews (approved photos only) with cursor pagination and myReview', async () => {
      await http().post(path()).set('Cookie', cookieFor(fx.users.u2.id)).send({ cleanliness: 2 }).expect(201);
      const page1 = await http().get(`${path()}?limit=1`).expect(200);
      expect(page1.body.items).toHaveLength(1);
      expect(page1.body.nextCursor).toBe(page1.body.items[0].id);
      const page2 = await http().get(`${path()}?limit=1&cursor=${page1.body.nextCursor}`).expect(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();
      const all = [...page1.body.items, ...page2.body.items];
      expect(all.every((r: { photos: unknown[] }) => r.photos.length === 0)).toBe(true); // unapproved

      const detail = await http()
        .get(`/toilets/${fx.toilets.a2.id}`)
        .set('Cookie', cookieFor(fx.users.u1.id))
        .expect(200);
      expect(detail.body.myReview).toMatchObject({ cleanliness: 3, photos: [{ id: fx.photos.u1Confirmed.id }] });
      expect(detail.body.reviews).toHaveLength(2);
      expect(detail.body.reviewCount).toBe(2);
      await http().get('/toilets/nope/reviews').expect(404);
    });
  });

  it('POST /toilets/:id/flags', async () => {
    const c = cookieFor(fx.users.u3.id);
    await http().post(`/toilets/${fx.toilets.a1.id}/flags`).send({ reason: 'Wrong level' }).expect(401);
    await http().post(`/toilets/${fx.toilets.a1.id}/flags`).set('Cookie', c).send({ reason: 'no' }).expect(400);
    const res = await http()
      .post(`/toilets/${fx.toilets.a1.id}/flags`)
      .set('Cookie', c)
      .send({ reason: 'It is on L2 now' })
      .expect(201);
    expect(await prisma.flag.findUnique({ where: { id: res.body.id } })).toMatchObject({ reason: 'It is on L2 now' });
    await http().post('/toilets/nope/flags').set('Cookie', c).send({ reason: 'Wrong level' }).expect(404);
  });

  it('GET /leaderboard/toilets ranks by cleanliness, per area', async () => {
    const res = await http().get('/leaderboard/toilets').expect(200);
    expect(res.body.areas).toEqual(['BISHAN', 'TOA PAYOH']);
    expect(res.body.items[0]).toMatchObject({ rank: 1 });
    const scores = res.body.items.map((i: { score: number }) => i.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    // RENOVATION toilet (9.9) is not ranked.
    expect(res.body.items.map((i: { toilet: { id: string } }) => i.toilet.id)).not.toContain(fx.toilets.closed.id);
    const area = await http().get('/leaderboard/toilets?area=toa%20payoh').expect(200);
    expect(area.body.items.map((i: { toilet: { id: string } }) => i.toilet.id)).toEqual([fx.toilets.e1.id]);
  });

  it('OpenAPI spec carries finder response types', async () => {
    const res = await http().get('/openapi.json').expect(200);
    const schemas = Object.keys(res.body.components.schemas);
    expect(schemas.some((s) => s.startsWith('ToiletSummary'))).toBe(true);
    expect(JSON.stringify(res.body.paths['/routing/recommend'].post.responses)).toMatch(/schema/);
  });
});
