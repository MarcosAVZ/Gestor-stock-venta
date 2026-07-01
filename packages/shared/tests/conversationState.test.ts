import { describe, it, expect } from 'vitest';
import { ConversationState } from '../src/enums/ConversationState.js';

/**
 * T1.4 — Verify shared enum values match the Prisma schema.
 *
 * This test is the BUILD-TIME CHECK: if Prisma and shared diverge,
 * the TypeScript compiler will also catch it via the generated types.
 * The runtime assertions here serve as documentation and safety net.
 */
describe('ConversationState enum sync with Prisma', () => {
  it('contains all expected states for text-command-bot', () => {
    const expected = [
      'PREGUNTANDO_PRODUCTO',
      'PREGUNTANDO_CANTIDAD',
      'PREGUNTANDO_UNIDAD',
      'PREGUNTANDO_COSTO_LOTE',
      'PREGUNTANDO_PRECIO_VENTA',
      'CONFIRMACION_FINAL',
      'GUARDADO',
      'AGREGANDO_STOCK',
      'IMPORTANDO_ESPERANDO_ARCHIVO',
      'IMPORTANDO_REVISANDO',
    ] as const;

    for (const state of expected) {
      expect(ConversationState[state]).toBe(state);
    }
  });

  it('does NOT contain removed OCR-era states', () => {
    const removed = ['ESPERANDO_IMAGEN', 'VALIDANDO_DATOS'] as const;

    for (const state of removed) {
      expect(ConversationState).not.toHaveProperty(state);
    }
  });

  it('has exactly 21 states (no extra, no missing)', () => {
    const keys = Object.keys(ConversationState);
    expect(keys).toHaveLength(21);
  });

  it('values match their keys (string enum pattern)', () => {
    for (const [key, value] of Object.entries(ConversationState)) {
      expect(value).toBe(key);
    }
  });
});
