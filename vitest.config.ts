import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './shared'),
      '@vox/plugin-sdk': path.resolve(__dirname, './packages/plugin-sdk/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'vox_eval_agentd'],
    testTimeout: 30000,
    // Hooks default to 10s while tests get 30s, which is backwards here: a
    // beforeAll typically logs in (bcrypt, CPU-bound) AND seeds fixtures over
    // HTTP, so it does strictly more work than the tests it sets up. With
    // suites running in parallel, several logins landing together pushed past
    // 10s and the whole suite failed on the hook with zero test failures.
    hookTimeout: 30000,
  },
});
