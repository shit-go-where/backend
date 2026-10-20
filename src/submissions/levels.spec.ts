/**
 * Levels on new toilets: normalised before the duplicate guard compares them, and required when
 * someone adds a toilet to a place that already has one. Prisma is stubbed: both checks run inside
 * the write transaction under the submitter and venue locks, and the stub's first write throws a
 * sentinel error.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { User } from '../generated/prisma/client.js';
import { LEVEL_NEEDED_MESSAGE, SubmissionsService, cleanLevel, sameLevel } from './submissions.service.js';
import type { CreateSubmissionBody } from './submissions.schemas.js';

const HERE = { lat: 1.3007, lng: 103.8451 };
const me = { id: 'u1', role: 'USER' } as User;

interface Near {
  id: string;
  latitude: number;
  longitude: number;
  level: string | null;
}

function service(opts: { listedAtVenue?: number; near?: Near[] } = {}) {
  const calls = { toiletCount: 0, created: false, locks: [] as string[], checkedUnlocked: false };
  const prisma = {
    submission: { count: async () => 0 },
    venue: { findUnique: async () => ({ id: 'v1' }), findMany: async () => [] },
    toilet: {
      count: async () => {
        calls.toiletCount++;
        return opts.listedAtVenue ?? 0;
      },
      findMany: async () => opts.near ?? [],
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const locked = (f: () => Promise<unknown>) => () => {
        if (calls.locks.length < 2) calls.checkedUnlocked = true;
        return f();
      };
      const tx = {
        // advisoryLock's tagged template: the key is the first interpolated value.
        $executeRaw: async (_sql: TemplateStringsArray, key: string) => {
          calls.locks.push(key);
          return 1;
        },
        submission: {
          count: prisma.submission.count,
          create: async () => {
            calls.created = true;
            throw new Error('CREATED');
          },
        },
        venue: {
          create: async () => {
            calls.created = true;
            throw new Error('CREATED');
          },
        },
        toilet: { count: locked(prisma.toilet.count), findMany: locked(prisma.toilet.findMany) },
      };
      return fn(tx);
    },
  };
  const presenter = { findSummaries: async () => [], toSummary: () => ({}) };
  const svc = new SubmissionsService(prisma as never, {} as never, {} as never, presenter as never);
  return { svc, calls };
}

const newToilet = (payload: Record<string, unknown>, force?: boolean): CreateSubmissionBody =>
  ({
    kind: 'NEW_TOILET',
    payload: { venueId: 'v1', lat: HERE.lat, lng: HERE.lng, features: {}, photoIds: [], ...payload },
    ...(force ? { force } : {}),
  }) as CreateSubmissionBody;

describe('sameLevel (duplicate guard)', () => {
  it('compares normalised levels', () => {
    expect(sameLevel('1', 'L1')).toBe(true);
    expect(sameLevel('Level 1', '1')).toBe(true);
    expect(sameLevel('ground floor', 'L1')).toBe(true);
    expect(sameLevel('basement 1', 'B01')).toBe(true);
    expect(sameLevel('B1; L3', 'lvl 3')).toBe(true);
    expect(sameLevel('B1', 'L1')).toBe(false);
    expect(sameLevel('L2', 'L3')).toBe(false);
  });
  it('an unknown level matches any', () => {
    expect(sameLevel(null, 'L1')).toBe(true);
    expect(sameLevel('B2', undefined)).toBe(true);
    expect(sameLevel('', '')).toBe(true);
  });
});

describe('cleanLevel', () => {
  it('normalises, and rejects a level with nothing in it', () => {
    expect(cleanLevel('level 3')).toBe('L3');
    expect(cleanLevel(undefined)).toBeUndefined();
    expect(() => cleanLevel(';')).toThrow(BadRequestException);
  });
});

describe('NEW_TOILET duplicate guard with normalised levels', () => {
  const near: Near[] = [{ id: 't-l1', latitude: HERE.lat, longitude: HERE.lng, level: 'L1' }];

  it('"Level 1" and "1" are the same floor as "L1": 409', async () => {
    for (const level of ['Level 1', '1', 'ground', 'l1']) {
      const { svc, calls } = service({ listedAtVenue: 1, near });
      await expect(svc.create(me, newToilet({ level }))).rejects.toBeInstanceOf(ConflictException);
      expect(calls.created).toBe(false);
    }
  });

  it('another floor at the same spot is not a duplicate', async () => {
    const { svc, calls } = service({ listedAtVenue: 1, near });
    await expect(svc.create(me, newToilet({ level: 'basement 1' }))).rejects.toThrow('CREATED');
    expect(calls.created).toBe(true);
  });

  it('checks under the submitter and venue locks', async () => {
    const { svc, calls } = service({ listedAtVenue: 1, near });
    await expect(svc.create(me, newToilet({ level: 'L1' }))).rejects.toBeInstanceOf(ConflictException);
    expect(calls.locks).toEqual(['submission:user:u1', 'submission:venue:v1']);
    expect(calls.checkedUnlocked).toBe(false);
  });

  it('the 409 lists the candidates', async () => {
    const { svc } = service({ listedAtVenue: 1, near });
    const err = await svc.create(me, newToilet({ level: 'L1' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ candidateIds: ['t-l1'] });
  });
});

describe('NEW_TOILET level required at a place that already has toilets', () => {
  it('400 without a level when the chosen venue has an ACTIVE or PENDING toilet', async () => {
    const { svc, calls } = service({ listedAtVenue: 2 });
    const err = await svc.create(me, newToilet({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toBe(LEVEL_NEEDED_MESSAGE);
    expect(calls.created).toBe(false);
    expect(calls.checkedUnlocked).toBe(false);
  });

  it('force does not skip it', async () => {
    const { svc } = service({ listedAtVenue: 1 });
    await expect(svc.create(me, newToilet({}, true))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('optional at a place with no toilets yet', async () => {
    const { svc } = service({ listedAtVenue: 0 });
    await expect(svc.create(me, newToilet({}))).rejects.toThrow('CREATED');
  });

  it('a level is enough, and the venue is not counted then', async () => {
    const { svc, calls } = service({ listedAtVenue: 3 });
    await expect(svc.create(me, newToilet({ level: 'B2' }))).rejects.toThrow('CREATED');
    expect(calls.toiletCount).toBe(0);
  });

  it('a level that normalises to nothing is a 400', async () => {
    const { svc } = service({ listedAtVenue: 0 });
    await expect(svc.create(me, newToilet({ level: ' ; ' }))).rejects.toBeInstanceOf(BadRequestException);
  });
});
