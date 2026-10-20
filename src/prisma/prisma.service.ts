import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { attachDatabasePool } from '@vercel/functions';
import pg from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../config/env.js';

/**
 * Wait at most this long for a free pooled connection. pg's default (0) waits forever, so under a
 * burst a request queued behind the pool hung until Vercel's 30 s cap instead of failing fast.
 */
export const DB_CONNECT_TIMEOUT_MS = 10_000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS });
    // Vercel Fluid compute: closes idle connections before the instance is suspended, so a frozen
    // instance does not hold Neon connections open. A no-op off Vercel.
    attachDatabasePool(pool);
    super({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
