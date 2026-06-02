import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/tests/**/*.test.ts', '**/tests/**/*.spec.ts', '**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/data/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.test.ts',
        '**/tests/**',
        '**/infrastructure/**',
        '**/config/**',
      ],
      thresholds: {
        // Lowered at PR1; tightened in later PRs (see sdd-tasks verification table).
        lines: 50,
        functions: 50,
        statements: 50,
        branches: 50,
      },
    },
  },
  resolve: {
    alias: {
      '@compras-whatsapp/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@compras-whatsapp/db': resolve(__dirname, 'packages/db/src/index.ts'),
    },
  },
});
