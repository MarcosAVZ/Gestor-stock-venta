/**
 * Tests de la unidad enum `Unidad` y sus schemas asociados en
 * `@compras-whatsapp/shared`. Cubre:
 *
 * - `UnidadSchema` (Zod): todas las variantes válidas + valores rechazados.
 * - `Unidad` (const object): los valores coinciden con la forma `'XXX'`.
 * - `opcionUnidadSchema`: palabras clave del usuario (T1.4 lo agrega a este file).
 *
 * Este test file es el ancla de WU1 (`Unidad.LOTE` foundation) del change
 * `ocr-parser-label-aware`. El valor `LOTE` es nuevo en este ciclo — los
 * tests asumen que el sistema de tipos lo acepta como un valor válido del
 * enum (el cual está sincronizado con el enum de Prisma vía una migración
 * generada en T1.6).
 */
import { describe, expect, it } from 'vitest';

import { Unidad, UnidadSchema } from '@compras-whatsapp/shared';

describe('Unidad const object', () => {
  it('expone los 6 valores canónicos', () => {
    expect(Unidad.UNIDAD).toBe('UNIDAD');
    expect(Unidad.PAR).toBe('PAR');
    expect(Unidad.PACK).toBe('PACK');
    expect(Unidad.CAJA).toBe('CAJA');
    expect(Unidad.LOTE).toBe('LOTE');
    expect(Unidad.OTRO).toBe('OTRO');
  });

  it('los valores son del tipo string literal de su clave', () => {
    // Garantiza que el const object mantenga el patrón de identidad
    // `Unidad.X === 'X'` que el código de `opcionUnidadSchema` aprovecha.
    for (const key of Object.keys(Unidad) as Array<keyof typeof Unidad>) {
      expect(Unidad[key]).toBe(key);
    }
  });
});

describe('UnidadSchema (Zod)', () => {
  it('acepta LOTE (valor nuevo en WU1)', () => {
    expect(UnidadSchema.parse('LOTE')).toBe('LOTE');
  });

  it('acepta los 6 valores del enum', () => {
    const values = ['UNIDAD', 'PAR', 'PACK', 'CAJA', 'LOTE', 'OTRO'] as const;
    for (const v of values) {
      expect(UnidadSchema.parse(v)).toBe(v);
    }
  });

  it('preserva backward-compat: los 5 valores previos siguen parseando', () => {
    expect(UnidadSchema.parse('UNIDAD')).toBe('UNIDAD');
    expect(UnidadSchema.parse('PAR')).toBe('PAR');
    expect(UnidadSchema.parse('PACK')).toBe('PACK');
    expect(UnidadSchema.parse('CAJA')).toBe('CAJA');
    expect(UnidadSchema.parse('OTRO')).toBe('OTRO');
  });

  it('rechaza valores fuera del enum', () => {
    expect(UnidadSchema.safeParse('KILO').success).toBe(false);
    expect(UnidadSchema.safeParse('docena').success).toBe(false);
    expect(UnidadSchema.safeParse('').success).toBe(false);
    expect(UnidadSchema.safeParse('lote').success).toBe(false); // lowercase NO es válido; solo 'LOTE' mayúscula
  });
});
