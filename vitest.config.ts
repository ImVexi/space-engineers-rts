import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@se-rts/schemas': r('./packages/schemas/src/index.ts'),
      '@se-rts/backend': r('./packages/backend/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    // T74: the suite runs as the marked test world (see the file's header).
    setupFiles: [
      './packages/backend/tests/setup-fixture-env.ts',
      // Removes this file's temp dirs at afterAll (the suite used to leak one
      // `se-rts-test-*` dir per temp store - 22 k dirs / 1.4 GB).
      './packages/backend/tests/setup-temp-dirs.ts',
    ],
    // Killed runs left dirs forever; sweep only ones older than 12 h.
    globalSetup: ['./packages/backend/tests/global-temp-sweep.ts'],
    include: [
      'packages/*/tests/**/*.test.ts',
      'packages/demo-site/tests/**/*.test.{ts,tsx}',
      'scenarios/tests/**/*.test.ts',
      'firmware/tests/**/*.test.mjs',
    ],
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/index.ts'],
      reportsDirectory: 'coverage',
    },
  },
});
