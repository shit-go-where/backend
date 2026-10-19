import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { buildOpenApi } from '../src/app.factory.js';
import {
  createContribApp,
  makePhoto,
  makeUser,
  offset,
  randomSgPoint,
  runId,
} from './contrib-fixtures.js';

describe('Submissions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const id = runId();
  const base = randomSgPoint();
  let alice: Awaited<ReturnType<typeof makeUser>>;
  let bob: Awaited<ReturnType<typeof makeUser>>;
  let carol: Awaited<ReturnType<typeof makeUser>>;
  let dave: Awaited<ReturnType<typeof makeUser>>;
  let tina: Awaited<ReturnType<typeof makeUser>>;
  let mo: Awaited<ReturnType<typeof makeUser>>;

  const http = () => request(app.getHttpServer());
  const newToilet = async (
    status: number,
    who: Awaited<ReturnType<typeof makeUser>>,
    at: { lat: number; lng: number },
    extra: Record<string, unknown> = {},
    body: Record<string, unknown> = {},
  ) => {
    const photo = await makePhoto(prisma, who.user.id);
    // Submitted from 500 m away by default, so it waits for nearby approvals (on-site flows: community.e2e-spec.ts).
    const from = offset(at, 500);
    return http()
      .post('/submissions')
      .set('Cookie', who.cookie)
      .send({
        kind: 'NEW_TOILET',
        lat: from.lat,
        lng: from.lng,
        ...body,
        payload: { lat: at.lat, lng: at.lng, features: { BIDET: true, ACCESSIBLE: false }, photoIds: [photo.id], ...extra },
      })
      .expect(status);
  };

  beforeAll(async () => {
    ({ app, prisma } = await createContribApp());
    alice = await makeUser(prisma, `alice-${id}`, { handle: `alice_${id}` });
    bob = await makeUser(prisma, `bob-${id}`);
    carol = await makeUser(prisma, `carol-${id}`);
    dave = await makeUser(prisma, `dave-${id}`);
    tina = await makeUser(prisma, `tina-${id}`, { role: 'TRUSTED' });
    mo = await makeUser(prisma, `mo-${id}`, { role: 'MODERATOR' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires sign-in', async () => {
    await http().post('/submissions').send({}).expect(401);
    await http().get('/submissions/mine').expect(401);
  });

  it('rejects an unknown kind, outside Singapore and foreign photos', async () => {
    await http().post('/submissions').set('Cookie', alice.cookie).send({ kind: 'NEW_VENUE', payload: {} }).expect(400);

    await newToilet(400, alice, { lat: 1.0, lng: 103.0 });

    const bobsPhoto = await makePhoto(prisma, bob.user.id);
    await newToilet(400, alice, base, { photoIds: [bobsPhoto.id] });
    const unconfirmed = await makePhoto(prisma, alice.user.id, false);
    await newToilet(400, alice, base, { photoIds: [unconfirmed.id] });
  });

  let subId: string;
  let toiletId: string;
  let venueId: string;

  it('creates a NEW_TOILET with a community venue and a pending toilet', async () => {
    const res = await newToilet(201, alice, base, {
      newVenue: { name: `Kopitiam ${id}`, type: 'COFFEESHOP' },
      label: 'Unisex at the back',
      level: 'L1',
      areaType: 'NOT_APPLICABLE',
    });
    const view = res.body;
    expect(view).toMatchObject({
      kind: 'NEW_TOILET',
      state: 'PENDING',
      approvals: 0,
      rejections: 0,
      canVote: false,
      myVote: null,
      submittedBy: { handle: `alice_${id}` },
      onSite: false,
      hasPhoto: true,
      path: 'nearby_quorum',
      nearbyApprovals: 0,
      needed: 2,
      escalated: false,
      reviewerNotes: [],
      current: null,
      resolution: null,
      resolutionText: null,
    });
    expect(view.submitterDistanceM).toBeGreaterThanOrEqual(499);
    expect(view.photos).toHaveLength(1);
    expect(view.venue).toMatchObject({ name: `Kopitiam ${id}`, type: 'COFFEESHOP', toiletStatus: 'HAS_TOILETS' });
    subId = view.id;
    toiletId = view.toilet.id;
    venueId = view.venue.id;

    const toilet = await prisma.toilet.findUniqueOrThrow({ where: { id: toiletId }, include: { features: true, venue: true } });
    expect(toilet).toMatchObject({
      status: 'PENDING',
      tier: 'COMMUNITY',
      source: 'COMMUNITY',
      sourceKey: `community:${subId}`,
      createdById: alice.user.id,
      level: 'L1',
    });
    expect(toilet.venue.sourceKey).toBe(`community-venue:${venueId}`);
    expect(toilet.venue.source).toBe('COMMUNITY');
    const feats = toilet.features
      .map((f) => [f.feature, f.present, f.source])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(feats).toEqual([
      ['ACCESSIBLE', false, 'COMMUNITY'],
      ['BIDET', true, 'COMMUNITY'],
    ]);
    const sub = await prisma.submission.findUniqueOrThrow({ where: { id: subId } });
    const days = (sub.expiresAt.getTime() - sub.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(60);
  });

  let dupSubId: string;

  it('snaps to the nearby venue and guards against duplicates unless forced', async () => {
    const near = offset(base, 5);
    const res = await newToilet(409, alice, near, { level: 'l1' });
    expect(res.body.candidateIds).toEqual([toiletId]);

    // a different level is not a duplicate
    const other = await newToilet(201, alice, near, { level: 'B1' });
    expect(other.body.venue.id).toBe(venueId);

    const forced = await newToilet(201, alice, near, { level: 'L1' }, { force: true });
    expect(forced.body.venue.id).toBe(venueId);
    dupSubId = forced.body.id;
  });

  it('shows the queue to others, nearest first, not to the submitter', async () => {
    const q = await http()
      .get('/submissions/queue')
      .query({ lat: base.lat, lng: base.lng, radius: 500 })
      .set('Cookie', bob.cookie)
      .expect(200);
    const mine = q.body.items.filter((i: { id: string }) => [subId, dupSubId].includes(i.id));
    expect(mine).toHaveLength(2);
    expect(q.body.items[0].distanceM).toBeLessThanOrEqual(q.body.items.at(-1).distanceM);
    expect(mine[0]).toMatchObject({ canVote: true, myVote: null });
    expect(mine[0].photos.length).toBe(1);

    const own = await http()
      .get('/submissions/queue')
      .query({ lat: base.lat, lng: base.lng, radius: 500 })
      .set('Cookie', alice.cookie)
      .expect(200);
    expect(own.body.items.find((i: { id: string }) => i.id === subId)).toBeUndefined();

    await http().get('/submissions/queue').set('Cookie', bob.cookie).expect(400); // lat/lng required
  });

  it('approves NEW_TOILET on two nearby votes and awards points + badges', async () => {
    await http().post(`/submissions/${subId}/votes`).set('Cookie', alice.cookie).send({ value: 'APPROVE' }).expect(403);

    const near = offset(base, 40);
    let r = await http()
      .post(`/submissions/${subId}/votes`)
      .set('Cookie', bob.cookie)
      .send({ value: 'APPROVE', ...near })
      .expect(201);
    expect(r.body).toMatchObject({ state: 'PENDING', approvals: 1, myVote: 'APPROVE', canVote: false });
    await http()
      .post(`/submissions/${subId}/votes`)
      .set('Cookie', bob.cookie)
      .send({ value: 'APPROVE', ...near })
      .expect(409);

    // far away / no location: counts as an approval but not toward the nearby quorum
    r = await http().post(`/submissions/${subId}/votes`).set('Cookie', carol.cookie).send({ value: 'APPROVE' }).expect(201);
    expect(r.body).toMatchObject({ state: 'PENDING', approvals: 2 });
    const vote = await prisma.submissionVote.findUniqueOrThrow({
      where: { submissionId_userId: { submissionId: subId, userId: bob.user.id } },
    });
    expect(vote.distanceM).toBeGreaterThanOrEqual(39);
    expect(vote.distanceM).toBeLessThanOrEqual(41);

    r = await http()
      .post(`/submissions/${subId}/votes`)
      .set('Cookie', dave.cookie)
      .send({ value: 'APPROVE', ...offset(base, -100) })
      .expect(201);
    expect(r.body).toMatchObject({ state: 'APPROVED', resolution: 'community_approved', needed: 0, nearbyApprovals: 2 });
    expect(r.body.resolvedAt).not.toBeNull();
    // Votes come back anonymised: value, note, when, nearby; never who.
    expect(r.body.reviewerNotes).toHaveLength(3);
    expect(Object.keys(r.body.reviewerNotes[0]).sort()).toEqual(['createdAt', 'nearby', 'note', 'value', 'viaCheckIn']);

    const toilet = await prisma.toilet.findUniqueOrThrow({ where: { id: toiletId } });
    expect(toilet.status).toBe('ACTIVE');
    expect(toilet.lastVerifiedAt).not.toBeNull();

    const ledger = await prisma.pointsLedger.findMany({ where: { refId: subId } });
    const byUser = Object.fromEntries(ledger.map((l) => [l.userId, `${l.reason}:${l.delta}`]));
    expect(byUser[alice.user.id]).toBe('SUBMISSION_APPROVED:20');
    expect(byUser[bob.user.id]).toBe('VOTE_MATCHED_OUTCOME:2');
    expect(byUser[carol.user.id]).toBe('VOTE_MATCHED_OUTCOME:2');
    expect(byUser[dave.user.id]).toBe('VOTE_MATCHED_OUTCOME:2');

    const badges = await prisma.userBadge.findMany({ where: { userId: alice.user.id } });
    expect(badges.map((b) => b.badgeId)).toContain('first-contribution');

    // resolved: no more votes
    await http().post(`/submissions/${subId}/votes`).set('Cookie', tina.cookie).send({ value: 'APPROVE' }).expect(409);
  });

  it('only takes an EDIT_TOILET from someone at the toilet', async () => {
    const edit = { kind: 'EDIT_TOILET', toiletId, payload: { changes: { features: { BIDET: false } } } };
    const noGps = await http().post('/submissions').set('Cookie', bob.cookie).send(edit).expect(400);
    expect(noGps.body.message).toMatch(/must be at the toilet/);
    const far = await http()
      .post('/submissions')
      .set('Cookie', bob.cookie)
      .send({ ...edit, ...offset(base, 400) })
      .expect(400);
    expect(far.body.message).toMatch(/within 150 m/);
    expect(await prisma.submission.count({ where: { kind: 'EDIT_TOILET', toiletId } })).toBe(0);
  });

  it('applies an EDIT_TOILET on one TRUSTED approval', async () => {
    const hours = { type: 'weekly', periods: [{ days: [0, 1, 2, 3, 4, 5, 6], open: '10:00', close: '22:00' }] };
    // Only 'always' or well-formed weekly hours: never raw OSM strings or bad times.
    for (const bad of [{ type: 'osm', value: '24/7' }, { type: 'weekly', periods: [{ days: [1], open: '25:00', close: '22:00' }] }]) {
      await http()
        .post('/submissions')
        .set('Cookie', bob.cookie)
        .send({ kind: 'EDIT_TOILET', toiletId, ...offset(base, 10), payload: { changes: { openingHours: bad } } })
        .expect(400);
    }
    await http()
      .post('/submissions')
      .set('Cookie', bob.cookie)
      .send({ kind: 'EDIT_TOILET', payload: { changes: {} } , toiletId, ...offset(base, 10) })
      .expect(400);
    const r = await http()
      .post('/submissions')
      .set('Cookie', bob.cookie)
      .send({
        kind: 'EDIT_TOILET',
        toiletId,
        ...offset(base, 20),
        payload: {
          changes: {
            label: 'Back corridor',
            nearestExit: 'Exit B',
            openingHours: hours,
            features: { BIDET: false, HAND_SOAP: true },
          },
          note: 'checked today',
        },
      })
      .expect(201);
    expect(r.body.toilet.id).toBe(toiletId);
    // Current → proposed, for the review card.
    expect(r.body.current).toEqual({
      label: 'Unisex at the back',
      nearestExit: null,
      openingHours: null,
      features: { BIDET: true, HAND_SOAP: null },
    });
    expect(r.body).toMatchObject({ onSite: true, path: 'nearby_quorum', needed: 2 });
    const v = await http().post(`/submissions/${r.body.id}/votes`).set('Cookie', tina.cookie).send({ value: 'APPROVE' }).expect(201);
    expect(v.body.state).toBe('APPROVED');

    const toilet = await prisma.toilet.findUniqueOrThrow({ where: { id: toiletId }, include: { features: true } });
    expect(toilet.label).toBe('Back corridor');
    expect(toilet.nearestExit).toBe('Exit B');
    expect(toilet.openingHours).toEqual(hours);
    const f = Object.fromEntries(toilet.features.map((x) => [x.feature, x.present]));
    expect(f).toMatchObject({ BIDET: false, HAND_SOAP: true, ACCESSIBLE: false });
    expect(toilet.features.every((x) => x.source === 'COMMUNITY')).toBe(true);
  });

  it('closes a toilet on one nearby approval of a CLOSE_TOILET', async () => {
    const r = await http()
      .post('/submissions')
      .set('Cookie', carol.cookie)
      .send({ kind: 'CLOSE_TOILET', toiletId, payload: { status: 'RENOVATION', reason: 'Hoarding up' } })
      .expect(201);
    const v = await http()
      .post(`/submissions/${r.body.id}/votes`)
      .set('Cookie', dave.cookie)
      .send({ value: 'APPROVE', ...offset(base, 10) })
      .expect(201);
    expect(v.body.state).toBe('APPROVED');
    expect((await prisma.toilet.findUniqueOrThrow({ where: { id: toiletId } })).status).toBe('RENOVATION');

    // no longer ACTIVE → cannot be edited
    await http()
      .post('/submissions')
      .set('Cookie', carol.cookie)
      .send({ kind: 'CLOSE_TOILET', toiletId, payload: { status: 'CLOSED', reason: 'x' } })
      .expect(400);
  });

  it('moves to NEEDS_INFO on two peer rejects, then REJECTED on a moderator reject', async () => {
    let r = await http().post(`/submissions/${dupSubId}/votes`).set('Cookie', bob.cookie).send({ value: 'REJECT' }).expect(201);
    expect(r.body.state).toBe('PENDING');
    r = await http().post(`/submissions/${dupSubId}/votes`).set('Cookie', carol.cookie).send({ value: 'REJECT', comment: 'dupe' }).expect(201);
    expect(r.body).toMatchObject({ state: 'NEEDS_INFO', rejections: 2, canVote: false });

    const asDave = await http().get(`/submissions/${dupSubId}`).set('Cookie', dave.cookie).expect(200);
    expect(asDave.body.canVote).toBe(true);

    r = await http().post(`/submissions/${dupSubId}/votes`).set('Cookie', mo.cookie).send({ value: 'REJECT' }).expect(201);
    expect(r.body.state).toBe('REJECTED');
    const sub = await prisma.submission.findUniqueOrThrow({ where: { id: dupSubId }, include: { toilet: true } });
    expect(sub.toilet?.status).toBe('REJECTED');
    expect(sub.resolvedById).toBe(mo.user.id);
    const matched = await prisma.pointsLedger.findMany({ where: { refId: dupSubId, reason: 'VOTE_MATCHED_OUTCOME' } });
    expect(matched.map((m) => m.userId).sort()).toEqual([bob.user.id, carol.user.id, mo.user.id].sort());
  });

  it('lets moderators resolve directly', async () => {
    const created = await newToilet(201, dave, offset(base, 0, 800));
    await http()
      .post(`/submissions/${created.body.id}/resolve`)
      .set('Cookie', tina.cookie)
      .send({ state: 'APPROVED' })
      .expect(403);
    const r = await http()
      .post(`/submissions/${created.body.id}/resolve`)
      .set('Cookie', mo.cookie)
      .send({ state: 'APPROVED', note: 'Looks right' })
      .expect(200);
    expect(r.body).toMatchObject({
      state: 'APPROVED',
      resolution: 'moderator_approved',
      resolutionText: 'Approved by a moderator.',
      resolutionNote: 'Looks right',
    });
    const sub = await prisma.submission.findUniqueOrThrow({ where: { id: created.body.id }, include: { toilet: true } });
    expect(sub.resolvedById).toBe(mo.user.id);
    expect(sub.toilet?.status).toBe('ACTIVE');
    await http()
      .post(`/submissions/${created.body.id}/resolve`)
      .set('Cookie', mo.cookie)
      .send({ state: 'REJECTED' })
      .expect(409);
  });

  it('lists my submissions and fetches one', async () => {
    const r = await http().get('/submissions/mine').set('Cookie', alice.cookie).expect(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([subId, dupSubId]));
    await http().get('/submissions/does-not-exist').set('Cookie', alice.cookie).expect(404);
  });

  it('publishes request and response schemas in the OpenAPI spec', () => {
    const doc = buildOpenApi(app);
    const post = doc.paths['/submissions']?.post;
    expect(JSON.stringify(post?.requestBody)).toMatch(/CreateSubmissionDto/);
    const body = JSON.stringify(doc.components?.schemas?.['CreateSubmissionDto']);
    expect(body).toMatch(/NEW_TOILET/);
    expect(body).toMatch(/CLOSE_TOILET/);
    expect(JSON.stringify(post?.responses?.['201'])).toMatch(/schema/);
    for (const p of ['/submissions/queue', '/me/passport', '/leaderboard/users', '/badges']) {
      expect(JSON.stringify(doc.paths[p]?.get?.responses), p).toMatch(/"200".*schema/);
    }
    expect(JSON.stringify(doc.paths['/toilets/{id}/check-ins']?.post?.responses?.['201'])).toMatch(/schema/);
  });

  it('limits a user to 10 open submissions', async () => {
    const spammer = await makeUser(prisma, `spam-${id}`);
    const far = randomSgPoint();
    for (let i = 0; i < 10; i++) {
      await newToilet(201, spammer, offset(far, i * 100), {}, { force: true });
    }
    const blocked = await newToilet(429, spammer, offset(far, 2000), {}, { force: true });
    expect(blocked.body.message).toMatch(/last 14 days/);
    // Submissions older than 14 days stop counting toward the cap.
    const oldest = await prisma.submission.findFirstOrThrow({ where: { submittedById: spammer.user.id } });
    await prisma.submission.update({ where: { id: oldest.id }, data: { createdAt: new Date(Date.now() - 15 * 86_400_000) } });
    await newToilet(201, spammer, offset(far, 2000), {}, { force: true });
  });
});
