import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * @compras-whatsapp/bot — vitest config.
 *
 * POR QUE EXISTE: el bot tiene su propio vitest.config para que
 * `pnpm --filter @compras-whatsapp/bot test:coverage` corra cobertura
 * acotada al bot, con excludes e includes bien definidos.
 *
 * El root `vitest.config.ts` cubre TODO el monorepo y se usa para
 * `pnpm test:coverage` (workspace-wide). El de aca es la vista
 * per-package del bot.
 *
 * COVERAGE THRESHOLDS (PR6 final):
 *   - 70% lines / functions / statements
 *   - 60% branches
 *
 * EXCLUDES:
 *   - src/index.ts               — entrypoint (signal handlers, process.on)
 *   - src/config/container.ts    — composition root (no testeable en aislacion)
 *   - src/infrastructure/messaging/WhatsAppClient.ts
 *                                 — wrapper de whatsapp-web.js (requiere sesion real)
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'data'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'node_modules',
        'dist',
        'data',
        'src/index.ts',
        'src/config/container.ts',
        'src/infrastructure/messaging/WhatsAppClient.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60,
      },
    },
  },
  resolve: {
    alias: {
      '@compras-whatsapp/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@compras-whatsapp/db': resolve(__dirname, '../../packages/db/src/index.ts'),
    },
  },
});
