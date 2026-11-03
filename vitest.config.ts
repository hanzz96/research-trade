import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // PGlite boots a real Postgres in WASM; the first start can take a few seconds.
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
