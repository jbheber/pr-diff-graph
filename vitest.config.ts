import { defineConfig } from 'vitest/config';

// Two projects: `unit` (unit + e2e, what `npm test` runs) and `perf` (`npm run test:perf`).
export default defineConfig({
  test: {
    testTimeout: 30000,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts', 'test/e2e/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'perf', include: ['test/perf/**/*.test.ts'], testTimeout: 120000 },
      },
    ],
  },
});
