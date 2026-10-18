import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

let client: PrismaClient | undefined;

/** Prisma client for CLI use. Uses DIRECT_URL (non-pooled) when set, else DATABASE_URL. */
export function getDb(): PrismaClient {
  if (client) return client;
  const connectionString = process.env['DIRECT_URL'] ?? process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('Set DIRECT_URL or DATABASE_URL');
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}

export async function closeDb(): Promise<void> {
  if (client) await client.$disconnect();
  client = undefined;
}
