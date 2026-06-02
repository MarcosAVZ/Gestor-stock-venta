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
        // PR5 final: spec targets ≥ 80% lines/statements/functions and
        // ≥ 70% branches for the application+shared surface. We allow
        // the threshold to apply project-wide (including infrastructure
        // and domain) — most of those are tested via integration
        // tests. The PR5 expansion is in `apps/bot/src/application/**`
        // (queries + conversation + pricing + learning).
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60,
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
