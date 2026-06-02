import { describe, expect, test } from 'vitest';

describe('apps/bot smoke', () => {
  test('vitest runs in apps/bot workspace', () => {
    // Smoke test: confirma que vitest descubrió el workspace apps/bot,
    // que el tsconfig local extiende correctamente el base, y que el
    // runner está conectado a pnpm -r test. Sin lógica de bot todavía.
    expect(1 + 1).toBe(2);
  });
});
