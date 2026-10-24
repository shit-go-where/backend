import { Prisma } from '../generated/prisma/client.js';
import { HANDLE_ADJECTIVES, HANDLE_NOUNS, randomHandle, withRandomHandle } from './handle-gen.js';
import { HANDLE_RE } from './users.dto.js';
import { isReservedHandle } from './users.service.js';

const p2002 = () => new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });

describe('random handles', () => {
  it('always fits the handle rules, even at the longest fallback', () => {
    for (const digits of [2, 3, 4]) {
      for (let i = 0; i < 500; i++) {
        const h = randomHandle(digits);
        expect(h).toMatch(HANDLE_RE);
        expect(isReservedHandle(h)).toBe(false);
        expect(h.split('_')[2]).toHaveLength(digits);
      }
    }
    const longest = (xs: readonly string[]) => Math.max(...xs.map((x) => x.length));
    expect(longest(HANDLE_ADJECTIVES) + longest(HANDLE_NOUNS) + 2 + 4).toBeLessThanOrEqual(20);
  });

  it('keeps word lists clean of duplicates and non-letters', () => {
    for (const list of [HANDLE_ADJECTIVES, HANDLE_NOUNS]) {
      expect(new Set(list).size).toBe(list.length);
      for (const w of list) expect(w).toMatch(/^[a-z]+$/);
    }
  });

  it('skips taken handles and retries a unique-constraint race', async () => {
    const taken = vi.fn(async () => false).mockResolvedValueOnce(true);
    const write = vi.fn(async (h: string) => h).mockRejectedValueOnce(p2002());
    const h = await withRandomHandle(taken, write);
    expect(h).toMatch(HANDLE_RE);
    expect(taken).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('moves to longer numbers when short ones keep colliding, then gives up', async () => {
    const seen: string[] = [];
    await expect(
      withRandomHandle(
        async (h) => (seen.push(h), true),
        async (h) => h,
      ),
    ).rejects.toThrow(/free handle/);
    expect(seen.map((h) => h.split('_')[2].length)).toEqual([2, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
  });

  it('passes other errors straight through', async () => {
    await expect(
      withRandomHandle(
        async () => false,
        async () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
  });
});
