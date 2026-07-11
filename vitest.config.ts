import { defineConfig } from 'vitest/config';

/** Unit tests: fast, no I/O, no containers. The default `pnpm test`. */
export default defineConfig({
  test: {
    name: 'unit',
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/unit/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/domain/src/**', 'packages/application/src/**'],
      // events.ts files are const maps with no logic; testing them would be theatre.
      exclude: ['**/*.test.ts', '**/index.ts', '**/events.ts'],
      // Gate from M2 design §8. Domain + application carry the invariants;
      // adapters are covered by integration tests instead.
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
