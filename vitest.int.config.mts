import { defineConfig } from 'vitest/config';

// Integration tests run against DATABASE_URL_TEST (a separate MySQL database).
// globalSetup resets the schema with `prisma migrate reset` once per run.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/integration/globalSetup.ts'],
    setupFiles: ['tests/integration/setupEnv.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
    env: { TZ: 'UTC' },
  },
});
