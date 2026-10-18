import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Migrations and seeding use the direct (non-pooled) connection.
// The app runtime uses DATABASE_URL (pooled on Neon) via PrismaService.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Neon's Vercel integration injects DATABASE_URL_UNPOOLED rather than DIRECT_URL.
    url:
      process.env['DIRECT_URL'] ?? process.env['DATABASE_URL_UNPOOLED'] ?? process.env['DATABASE_URL'],
    shadowDatabaseUrl: process.env['SHADOW_DATABASE_URL'],
  },
});
