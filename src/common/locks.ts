import type { Prisma } from '../generated/prisma/client.js';

/**
 * Transaction-scoped Postgres advisory lock on an arbitrary key (released at commit or rollback).
 * Serialises check-then-insert sequences per person (cooldowns, daily caps, open-submission caps)
 * across every function instance, which an in-memory lock cannot do. `hashtext` folds the key
 * into the 32-bit lock space; a rare collision only makes two unrelated callers wait on each other.
 */
export async function advisoryLock(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}
