/**
 * Tests del use case puro `calcularMetricas`.
 *
 * Casos típicos del spec (sdd-design obs#28 §6 + req-tests):
 * - 1000/20/6000 → costoUnitario=50, ganancia=5950, margen=99.17%, markup=11900%
 * - 0/20/6000    → throw (costoLote <= 0)
 * - 20/0/6000   → throw (cantidadReal <= 0)
 * - 1500/12/2500 → costoUnitario=125, ganancia=2375
 *
 * También cubrimos:
 * - Precios con decimales: 100.5/3/50.5
 * - Pérdida (precioVenta < costoUnitario) → margen y ganancia negativos.
 * - Redondeo: verificamos que no hay drift de float.
 */
import { describe, expect, it } from 'vitest';

import { InvariantViolationError } from '../../src/domain/errors/ProgrammerError.ts';
import { calcularMetricas } from '../../src/application/pricing/CalcularMetricas.ts';

describe('calcularMetricas', () => {
  it('caso 1000/20/6000: costo unitario 50, ganancia 5950, margen 99.17%', () => {
    const r = calcularMetricas({ costoLote: 1000, cantidadReal: 20, precioVenta: 6000 });
    expect(r.costoUnitario.toNumber()).toBe(50);
    expect(r.gananciaUnitaria.toNumber()).toBe(5950);
    // margen = 5950/6000 = 0.991666...
    expect(r.margenBruto.toNumber()).toBeCloseTo(0.9917, 3);
    // markup = 5950/50 = 119
    expect(r.markup.toNumber()).toBe(119);
    expect(r.ventaTotalEstimada.toNumber()).toBe(120_000);
    expect(r.gananciaTotalEstimada.toNumber()).toBe(119_000);
  });

  it('caso 1500/12/2500: costo 125, ganancia 2375, margen 95%', () => {
    const r = calcularMetricas({ costoLote: 1500, cantidadReal: 12, precioVenta: 2500 });
    expect(r.costoUnitario.toNumber()).toBe(125);
    expect(r.gananciaUnitaria.toNumber()).toBe(2375);
    expect(r.margenBruto.toNumber()).toBe(0.95);
    expect(r.markup.toNumber()).toBe(19); // 2375/125
    expect(r.ventaTotalEstimada.toNumber()).toBe(30_000);
    expect(r.gananciaTotalEstimada.toNumber()).toBe(28_500);
  });

  it('caso decimal 1234.56 / 7 / 350.5: precisión exacta sin drift', () => {
    const r = calcularMetricas({
      costoLote: 1234.56,
      cantidadReal: 7,
      precioVenta: 350.5,
    });
    // 1234.56/7 = 176.3657142857... (no se redondea acá)
    expect(r.costoUnitario.toNumber()).toBeCloseTo(176.366, 3);
    // 350.5 - 176.365714... = 174.134285...
    expect(r.gananciaUnitaria.toNumber()).toBeCloseTo(174.134, 3);
    // 174.134... / 350.5 ≈ 0.4968
    expect(r.margenBruto.toNumber()).toBeCloseTo(0.4968, 3);
    // 174.134... / 176.366... ≈ 0.9873
    expect(r.markup.toNumber()).toBeCloseTo(0.9873, 3);
  });

  it('precioVenta == costoUnitario: margen 0, ganancia 0 (break-even)', () => {
    const r = calcularMetricas({ costoLote: 1000, cantidadReal: 10, precioVenta: 100 });
    // costoUnitario = 100, precioVenta = 100 → ganancia 0
    expect(r.costoUnitario.toNumber()).toBe(100);
    expect(r.gananciaUnitaria.toNumber()).toBe(0);
    expect(r.margenBruto.toNumber()).toBe(0);
    expect(r.markup.toNumber()).toBe(0);
    expect(r.gananciaTotalEstimada.toNumber()).toBe(0);
  });

  it('precioVenta < costoUnitario: pérdida, margen y markup negativos', () => {
    const r = calcularMetricas({ costoLote: 1000, cantidadReal: 10, precioVenta: 50 });
    // costoUnitario = 100, precioVenta = 50 → ganancia = -50
    expect(r.gananciaUnitaria.toNumber()).toBe(-50);
    expect(r.margenBruto.toNumber()).toBe(-1); // -50/50
    expect(r.markup.toNumber()).toBe(-0.5); // -50/100
    expect(r.gananciaTotalEstimada.toNumber()).toBe(-500);
  });

  it('costoLote = 0 → throw InvariantViolationError', () => {
    expect(() => calcularMetricas({ costoLote: 0, cantidadReal: 20, precioVenta: 6000 })).toThrow(
      InvariantViolationError,
    );
  });

  it('cantidadReal = 0 → throw InvariantViolationError (división por cero)', () => {
    expect(() => calcularMetricas({ costoLote: 1000, cantidadReal: 0, precioVenta: 6000 })).toThrow(
      InvariantViolationError,
    );
  });

  it('precioVenta = 0 → throw InvariantViolationError', () => {
    expect(() => calcularMetricas({ costoLote: 1000, cantidadReal: 20, precioVenta: 0 })).toThrow(
      InvariantViolationError,
    );
  });

  it('cantidadReal negativo → throw', () => {
    expect(() =>
      calcularMetricas({ costoLote: 1000, cantidadReal: -5, precioVenta: 6000 }),
    ).toThrow(InvariantViolationError);
  });

  it('NaN/Infinity en precioVenta → throw', () => {
    expect(() =>
      calcularMetricas({ costoLote: 1000, cantidadReal: 20, precioVenta: Number.NaN }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      calcularMetricas({ costoLote: 1000, cantidadReal: 20, precioVenta: Number.POSITIVE_INFINITY }),
    ).toThrow(InvariantViolationError);
  });

  it('el output usa Decimal: `.toString()` no tiene drift de float', () => {
    // Caso clásico: 0.1 + 0.2 !== 0.3 con float; con Decimal sí.
    const r = calcularMetricas({
      costoLote: 0.3,
      cantidadReal: 1,
      precioVenta: 0.1,
    });
    // costoUnitario = 0.3 (exacto en Decimal)
    expect(r.costoUnitario.toString()).toBe('0.3');
    // ganancia = 0.1 - 0.3 = -0.2 (exacto en Decimal)
    expect(r.gananciaUnitaria.toString()).toBe('-0.2');
  });
});
