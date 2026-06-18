/**
 * Tests unitarios para el parser de comandos de escritura (T2.2 — RED).
 *
 * Verifica que parseCommand:
 * - Detecte /nueva y nueva → { type: 'nueva' }
 * - Detecte /agregar y agregar → { type: 'agregar' }
 * - Detecte /ayuda, /help y help → { type: 'ayuda' }
 * - Sea case-insensitive (/NUEVA → nueva)
 * - Haga trim de whitespace
 * - Retorne null para comandos de query (/resumen), texto libre, vacío
 * - Retorne null si hay argumentos extra (/nueva compra)
 */
import { describe, expect, it } from 'vitest';

import { parseCommand } from '../../src/application/commands/parseCommand.ts';

describe('parseCommand', () => {
  // ── /nueva ────────────────────────────────────────────────────────
  it('/nueva → nueva', () => {
    expect(parseCommand('/nueva')).toEqual({ type: 'nueva' });
  });

  it('nueva (sin slash) → nueva', () => {
    expect(parseCommand('nueva')).toEqual({ type: 'nueva' });
  });

  // ── /agregar ──────────────────────────────────────────────────────
  it('/agregar → agregar', () => {
    expect(parseCommand('/agregar')).toEqual({ type: 'agregar' });
  });

  it('agregar (sin slash) → agregar', () => {
    expect(parseCommand('agregar')).toEqual({ type: 'agregar' });
  });

  // ── /ayuda ────────────────────────────────────────────────────────
  it('/ayuda → ayuda', () => {
    expect(parseCommand('/ayuda')).toEqual({ type: 'ayuda' });
  });

  it('/help → ayuda', () => {
    expect(parseCommand('/help')).toEqual({ type: 'ayuda' });
  });

  it('help (sin slash) → ayuda', () => {
    expect(parseCommand('help')).toEqual({ type: 'ayuda' });
  });

  // ── Case-insensitive ──────────────────────────────────────────────
  it('/NUEVA (uppercase) → nueva', () => {
    expect(parseCommand('/NUEVA')).toEqual({ type: 'nueva' });
  });

  // ── Whitespace trimming ───────────────────────────────────────────
  it('  /nueva  (con espacios) → nueva', () => {
    expect(parseCommand('  /nueva  ')).toEqual({ type: 'nueva' });
  });

  // ── Null cases ────────────────────────────────────────────────────
  it('/resumen → null (es query, no bot command)', () => {
    expect(parseCommand('/resumen')).toBeNull();
  });

  it('hola → null (texto libre)', () => {
    expect(parseCommand('hola')).toBeNull();
  });

  it('"" (vacío) → null', () => {
    expect(parseCommand('')).toBeNull();
  });

  it('/nueva compra → null (argumentos extra no soportados)', () => {
    expect(parseCommand('/nueva compra')).toBeNull();
  });

  // ── /vender ──────────────────────────────────────────────────────
  it('/vender → vender', () => {
    expect(parseCommand('/vender')).toEqual({ type: 'vender' });
  });

  it('vender (sin slash) → vender', () => {
    expect(parseCommand('vender')).toEqual({ type: 'vender' });
  });

  it('/VENDER (uppercase) → vender', () => {
    expect(parseCommand('/VENDER')).toEqual({ type: 'vender' });
  });
});
