import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.ts'],
    // Run single worker to avoid flakiness from shared in-memory store & schedulers
    pool: 'threads',
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 1
      }
    },
    include: ['tests/**/*.test.ts']
  }
});
