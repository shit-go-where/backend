import { randomInt } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { HANDLE_RE } from './users.dto.js';
import { isReservedHandle } from './users.service.js';

/**
 * Random handles every account starts with, so the leaderboard is pseudonymous by default: never
 * built from a Google name or email. Words are kept to 6 + 8 letters so even the longest fallback
 * (4 digits) fits HANDLE_RE. The migration 20261024200000_auto_handles backfills with the same lists.
 */
export const HANDLE_ADJECTIVES = [
  'shiok', 'steady', 'garang', 'kiasu', 'atas', 'swee', 'paiseh', 'chill',
  'solid', 'sporty', 'zippy', 'sunny', 'jolly', 'lucky', 'comfy', 'brave',
  'breezy', 'cheery', 'mellow', 'nifty', 'plucky', 'speedy', 'sleepy', 'cosy',
] as const;

export const HANDLE_NOUNS = [
  'otter', 'pigeon', 'mynah', 'merlion', 'durian', 'kopi', 'teh', 'kaya',
  'prata', 'satay', 'laksa', 'rojak', 'chendol', 'kueh', 'otah', 'ondeh',
  'popiah', 'hornbill', 'pangolin', 'dugong', 'heron', 'bulbul', 'koel', 'macaque',
  'tembusu', 'rambutan', 'bandung', 'tauhu',
] as const;

type Rand = (max: number) => number;
const cryptoRand: Rand = (max) => randomInt(max);

/** adjective_noun_NN; `digits` grows (2, 3, 4) when retries keep colliding. */
export function randomHandle(digits = 2, rand: Rand = cryptoRand): string {
  const adj = HANDLE_ADJECTIVES[rand(HANDLE_ADJECTIVES.length)];
  const noun = HANDLE_NOUNS[rand(HANDLE_NOUNS.length)];
  const low = 10 ** (digits - 1);
  return `${adj}_${noun}_${low + rand(9 * low)}`;
}

const ATTEMPTS = 10;
/** Digits for each attempt: a few tries at 2, then 3, then 4. */
const digitsFor = (attempt: number) => (attempt < 4 ? 2 : attempt < 7 ? 3 : 4);

/**
 * Runs `write` with a fresh random handle, retrying with a new one when it is taken: checked first,
 * and again on a unique-constraint race (P2002) at write time.
 */
export async function withRandomHandle<T>(
  isTaken: (handle: string) => Promise<boolean>,
  write: (handle: string) => Promise<T>,
  rand: Rand = cryptoRand,
): Promise<T> {
  let lastError: unknown = new Error('Could not find a free handle');
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const handle = randomHandle(digitsFor(attempt), rand);
    if (!HANDLE_RE.test(handle) || isReservedHandle(handle) || (await isTaken(handle))) continue;
    try {
      return await write(handle);
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      lastError = e;
    }
  }
  throw lastError;
}
