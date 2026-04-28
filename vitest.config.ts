import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals:      true,
    environment:  'node',
    testTimeout:  60_000,
    hookTimeout:  30_000,
    setupFiles:   ['./tests/setup.ts'],
  },
});