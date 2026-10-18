import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

let client: PrismaClient | undefined;

/**
 * Prisma client for CLI use. Prefers a non-pooled URL: DIRECT_URL, then DATABASE_URL_UNPOOLED
 * (what Neon's Vercel integration injects), else DATABASE_URL.
 */
export function getDb(): PrismaClient {
  if (client) return client;
  const connectionString =
    process.env['DIRECT_URL'] ?? process.env['DATABASE_URL_UNPOOLED'] ?? process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('Set DIRECT_URL or DATABASE_URL');
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}

export async function closeDb(): Promise<void> {
  if (client) await client.$disconnect();
  client = undefined;
}
