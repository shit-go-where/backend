import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    // Suites share one database and some fixtures truncate tables, so run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    // beforeAll hooks build the whole Nest app; cold imports alone can take over the 10 s default.
    hookTimeout: 60_000,
  },
});
