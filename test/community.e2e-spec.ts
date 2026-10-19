/** Trust model v2, check-ins on pending toilets, escalation and the moderator queue (PLAN.md §12 E1-E3). */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { AdminService } from '../src/admin/admin.service.js';
import { createContribApp, makePhoto, makeUser, offset, randomSgPoint, runId } from './contrib-fixtures.js';

type U = Awaited<ReturnType<typeof makeUser>>;

describe('Community loop (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const id = runId();
  let sam: U; // submitter
  let pia: U; // a passer-by who checks in
  let quinn: U;
  let mo: U;
  const http = () => request(app.getHttpServer());

  /** A NEW_TOILET at `pin`, submitted standing at `standing` (null = no location). */
  const submit = async (
    status: number,
    who: U,
    pin: { lat: number; lng: number },
    standing: { lat: number; lng: number } | null,
    photo = true,
  ) => {
    const photoIds = photo ? [(await makePhoto(prisma, who.user.id)).id] : [];
    return http()
      .post('/submissions')
      .set('Cookie', who.cookie)
      .send({
        kind: 'NEW_TOILET',
        ...standing,
        force: true,
        payload: { lat: pin.lat, lng: pin.lng, features: { BIDET: true }, photoIds },
      })
      .expect(status);
  };
  const checkIn = (who: U, toiletId: string, at: { lat: number; lng: number }) =>
    http().post(`/toilets/${toiletId}/check-ins`).set('Cookie', who.cookie).send(at);
  const ledger = (userId: string, refId: string) =>
    prisma.pointsLedger.findMany({ where: { userId, refId } }).then((rows) => rows.map((r) => `${r.reason}:${r.delta}`).sort());

  beforeAll(async () => {
    ({ app, prisma } = await createContribApp());
    sam = await makeUser(prisma, `sam-${id}`, { handle: `sam_${id}` });
    pia = await makeUser(prisma, `pia-${id}`);
    quinn = await makeUser(prisma, `quinn-${id}`);
    mo = await makeUser(prisma, `mo-${id}`, { role: 'MODERATOR' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('publishes an on-site toilet with a photo at once, +5 now and +15 when a second person checks in', async () => {
    const pin = randomSgPoint();
    const res = await submit(201, sam, pin, offset(pin, 30));
    expect(res.body).toMatchObject({
      state: 'APPROVED',
      onSite: true,
      hasPhoto: true,
      path: 'auto',
      needed: 0,
      resolution: 'auto_on_site_photo',
      resolutionText: 'Live straight away: added on site with a photo.',
    });
    const toiletId = res.body.toilet.id;
    let toilet = await prisma.toilet.findUniqueOrThrow({ where: { id: toiletId } });
    expect(toilet).toMatchObject({ status: 'ACTIVE', tier: 'COMMUNITY', seenBy: 1 });
    expect(toilet.lastVerifiedAt).not.toBeNull();
    expect(await ledger(sam.user.id, res.body.id)).toEqual(['NEW_TOILET_SUBMITTED:5']);
    const badges = await prisma.userBadge.findMany({ where: { userId: sam.user.id } });
    expect(badges.map((b) => b.badgeId)).toContain('first-contribution');

    // The submitter checking in confirms nothing and is already counted in seenBy.
    const own = await checkIn(sam, toiletId, pin).expect(201);
    expect(own.body.confirmedPending).toBe(false);

    const c = await checkIn(pia, toiletId, offset(pin, 40)).expect(201);
    expect(c.body).toMatchObject({ confirmedPending: true, wentLive: false, bankedPoints: 0 });
    expect(await ledger(sam.user.id, res.body.id)).toEqual(['NEW_TOILET_CONFIRMED:15', 'NEW_TOILET_SUBMITTED:5']);
    toilet = await prisma.toilet.findUniqueOrThrow({ where: { id: toiletId } });
    expect(toilet.seenBy).toBe(2);
    const vote = await prisma.submissionVote.findUniqueOrThrow({
      where: { submissionId_userId: { submissionId: res.body.id, userId: pia.user.id } },
    });
    expect(vote).toMatchObject({ value: 'APPROVE', checkInId: c.body.id });

    // A third person: seenBy grows, no more points for the submitter.
    await checkIn(quinn, toiletId, pin).expect(201);
    expect((await prisma.toilet.findUniqueOrThrow({ where: { id: toiletId } })).seenBy).toBe(3);
    expect(await ledger(sam.user.id, res.body.id)).toHaveLength(2);
  });

  it('puts an on-site toilet without a photo live on the first check-in by someone else', async () => {
    const pin = randomSgPoint();
    const res = await submit(201, sam, pin, pin, false);
    expect(res.body).toMatchObject({ state: 'PENDING', onSite: true, hasPhoto: false, path: 'on_site_check_in', needed: 1 });
    const toiletId = res.body.toilet.id;

    const c = await checkIn(pia, toiletId, offset(pin, -60)).expect(201);
    expect(c.body).toMatchObject({ confirmedPending: true, wentLive: true });
    const view = await http().get(`/submissions/${res.body.id}`).set('Cookie', sam.cookie).expect(200);
    expect(view.body).toMatchObject({
      state: 'APPROVED',
      resolution: 'confirmed_on_site',
      nearbyApprovals: 1,
      needed: 0,
      reviewerNotes: [{ value: 'APPROVE', note: null, nearby: true, viaCheckIn: true }],
    });
    expect((await prisma.toilet.findUniqueOrThrow({ where: { id: toiletId } })).status).toBe('ACTIVE');
    expect(await ledger(sam.user.id, res.body.id)).toEqual(['SUBMISSION_APPROVED:20']);
    expect(await ledger(pia.user.id, res.body.id)).toEqual(['VOTE_MATCHED_OUTCOME:2']);
  });

  it('needs two nearby confirmations for a remote submission; a check-in is one of them', async () => {
    const pin = randomSgPoint();
    const res = await submit(201, sam, pin, null);
    expect(res.body).toMatchObject({ state: 'PENDING', onSite: false, path: 'nearby_quorum', needed: 2 });
    const toiletId = res.body.toilet.id;
    const c = await checkIn(pia, toiletId, pin).expect(201);
    expect(c.body).toMatchObject({ confirmedPending: true, wentLive: false });
    let view = await http().get(`/submissions/${res.body.id}`).set('Cookie', sam.cookie).expect(200);
    expect(view.body).toMatchObject({ state: 'PENDING', nearbyApprovals: 1, needed: 1 });
    // Checking in again later does not vote twice.
    await prisma.checkIn.updateMany({ where: { userId: pia.user.id, toiletId }, data: { createdAt: new Date(Date.now() - 3 * 3_600_000) } });
    const again = await checkIn(pia, toiletId, pin).expect(201);
    expect(again.body.confirmedPending).toBe(false);

    const v = await http()
      .post(`/submissions/${res.body.id}/votes`)
      .set('Cookie', quinn.cookie)
      .send({ value: 'APPROVE', ...offset(pin, 10) })
      .expect(201);
    expect(v.body).toMatchObject({ state: 'APPROVED', resolution: 'community_approved' });
    view = await http().get(`/submissions/${res.body.id}`).set('Cookie', sam.cookie).expect(200);
    expect(view.body.reviewerNotes.map((n: { viaCheckIn: boolean }) => n.viaCheckIn).sort()).toEqual([false, true]);
  });

  it('caps auto-publish at 3 a day, then waits for a check-in', async () => {
    const busy = await makeUser(prisma, `busy-${id}`);
    const states: string[] = [];
    for (let i = 0; i < 4; i++) {
      const pin = randomSgPoint();
      const r = await submit(201, busy, pin, pin);
      states.push(`${r.body.state}:${r.body.path}`);
    }
    expect(states).toEqual([
      'APPROVED:auto',
      'APPROVED:auto',
      'APPROVED:auto',
      'PENDING:on_site_check_in',
    ]);
  });

  it('pauses auto-publish for 30 days after a rejection', async () => {
    const burnt = await makeUser(prisma, `burnt-${id}`);
    const first = await submit(201, burnt, randomSgPoint(), null);
    await http().post(`/submissions/${first.body.id}/resolve`).set('Cookie', mo.cookie).send({ state: 'REJECTED' }).expect(200);
    const pin = randomSgPoint();
    const r = await submit(201, burnt, pin, pin);
    expect(r.body).toMatchObject({ state: 'PENDING', path: 'on_site_check_in' });
  });

  let flaggedSubId: string;

  it('sends an auto-published toilet back to pending when two people flag it', async () => {
    const pin = randomSgPoint();
    const res = await submit(201, sam, pin, pin);
    flaggedSubId = res.body.id;
    const toiletId = res.body.toilet.id;
    const flag = (who: U) =>
      http()
        .post(`/toilets/${toiletId}/verify`)
        .set('Cookie', who.cookie)
        .send({ ...pin, accurate: false, note: 'No toilet here' })
        .expect(200);
    await flag(pia);
    await flag(pia); // the same person twice counts once
    expect((await prisma.toilet.findUniqueOrThrow({ where: { id: toiletId } })).status).toBe('ACTIVE');
    await flag(quinn);
    expect((await prisma.toilet.findUniqueOrThrow({ where: { id: toiletId } })).status).toBe('PENDING');
    const view = await http().get(`/submissions/${res.body.id}`).set('Cookie', sam.cookie).expect(200);
    expect(view.body).toMatchObject({ state: 'ESCALATED', escalated: true, resolution: 'escalated_flagged', needed: 0 });

    // Only a moderator decides now: no peer votes, and check-ins do not confirm it.
    const other = await makeUser(prisma, `other-${id}`);
    await http().post(`/submissions/${res.body.id}/votes`).set('Cookie', other.cookie).send({ value: 'APPROVE', ...pin }).expect(409);
    const c = await checkIn(other, toiletId, pin).expect(201);
    expect(c.body.confirmedPending).toBe(false);
  });

  it('lists the moderator queue island-wide, escalated first, and resolves from it', async () => {
    await http().get('/admin/submissions').set('Cookie', pia.cookie).expect(403);
    // An overdue one is escalated by the expire job, and its toilet stays pending.
    const stale = await submit(201, quinn, randomSgPoint(), null);
    await prisma.submission.update({ where: { id: stale.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    // AdminModule is not mounted here; the expire job only needs Prisma.
    await new AdminService(prisma, null as never, null as never).runJob('expire-submissions');
    const staleRow = await prisma.submission.findUniqueOrThrow({ where: { id: stale.body.id }, include: { toilet: true } });
    expect(staleRow).toMatchObject({ state: 'ESCALATED', resolution: 'escalated_expired' });
    expect(staleRow.toilet?.status).toBe('PENDING');

    const q = await http().get('/admin/submissions').set('Cookie', mo.cookie).expect(200);
    const ids = q.body.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual(expect.arrayContaining([flaggedSubId, stale.body.id]));
    const firstOpen = q.body.items.findIndex((i: { escalated: boolean }) => !i.escalated);
    const lastEscalated = q.body.items.map((i: { escalated: boolean }) => i.escalated).lastIndexOf(true);
    if (firstOpen !== -1) expect(lastEscalated).toBeLessThan(firstOpen);
    const item = q.body.items.find((i: { id: string }) => i.id === stale.body.id);
    expect(item).toMatchObject({ kind: 'NEW_TOILET', onSite: false, hasPhoto: true, approvals: 0, ageDays: 0 });
    expect(item.photos).toHaveLength(1);

    const pendingOnly = await http().get('/admin/submissions?state=pending').set('Cookie', mo.cookie).expect(200);
    expect(pendingOnly.body.items.every((i: { state: string }) => i.state === 'PENDING')).toBe(true);
    await http().get('/admin/submissions?state=nope').set('Cookie', mo.cookie).expect(400);

    // An escalated (expired) one can still be confirmed by someone nearby...
    const pin = { lat: stale.body.toilet.lat, lng: stale.body.toilet.lng };
    const c = await checkIn(pia, stale.body.toilet.id, pin).expect(201);
    expect(c.body.confirmedPending).toBe(true);
    // ...and moderators resolve escalated ones like pending ones.
    const r = await http()
      .post(`/submissions/${flaggedSubId}/resolve`)
      .set('Cookie', mo.cookie)
      .send({ state: 'APPROVED', note: 'Checked on Street View' })
      .expect(200);
    expect(r.body).toMatchObject({ state: 'APPROVED', resolution: 'moderator_approved', resolutionNote: 'Checked on Street View' });
    // Total for an auto-published toilet stays 20.
    expect(await ledger(sam.user.id, flaggedSubId)).toEqual(['NEW_TOILET_CONFIRMED:15', 'NEW_TOILET_SUBMITTED:5']);
  });

  it('lets the submitter answer NEEDS_INFO, which puts it back to PENDING', async () => {
    const pin = randomSgPoint();
    const res = await submit(201, sam, pin, null, false);
    const subId = res.body.id;
    await http().patch(`/submissions/${subId}`).set('Cookie', sam.cookie).send({ note: 'Level 2' }).expect(409);
    for (const who of [pia, quinn]) {
      await http().post(`/submissions/${subId}/votes`).set('Cookie', who.cookie).send({ value: 'REJECT', comment: 'Which floor?' }).expect(201);
    }
    let view = await http().get(`/submissions/${subId}`).set('Cookie', sam.cookie).expect(200);
    expect(view.body).toMatchObject({ state: 'NEEDS_INFO', resolution: 'peer_needs_info', rejections: 2 });
    expect(view.body.reviewerNotes).toEqual([
      expect.objectContaining({ value: 'REJECT', note: 'Which floor?' }),
      expect.objectContaining({ value: 'REJECT', note: 'Which floor?' }),
    ]);

    await http().patch(`/submissions/${subId}`).set('Cookie', pia.cookie).send({ note: 'x' }).expect(404);
    await http().patch(`/submissions/${subId}`).set('Cookie', sam.cookie).send({}).expect(400);
    const photo = await makePhoto(prisma, sam.user.id);
    view = await http()
      .patch(`/submissions/${subId}`)
      .set('Cookie', sam.cookie)
      .send({ note: 'It is on level 2, behind the lifts', level: 'L2', photoIds: [photo.id] })
      .expect(200);
    expect(view.body).toMatchObject({
      state: 'PENDING',
      rejections: 0,
      hasPhoto: true,
      resolution: null,
      payload: { note: 'It is on level 2, behind the lifts', level: 'L2', photoIds: [photo.id] },
      reviewerNotes: [],
    });
    expect(view.body.photos).toHaveLength(1);
    expect((await prisma.toilet.findUniqueOrThrow({ where: { id: res.body.toilet.id } })).level).toBe('L2');
    // Reviewers who rejected can look again.
    await http().post(`/submissions/${subId}/votes`).set('Cookie', pia.cookie).send({ value: 'APPROVE', ...pin }).expect(201);
  });
});
