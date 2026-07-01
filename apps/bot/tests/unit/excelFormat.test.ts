/**
 * Tests para el formato compartido de Excel (TDD: RED).
 *
 * Verifica que ExcelFormat defina correctamente:
 * - Nombres de hojas
 * - Columnas por hoja con sus tipos y modo readonly
 * - Columnas importables
 */
import { describe, expect, it } from 'vitest';

import {
  COLUMNS,
  IMPORTABLE_COLUMNS,
  SHEETS,
} from '../../src/application/excel/ExcelFormat.ts';

describe('ExcelFormat', () => {
  // ── Sheet names ────────────────────────────────────────────────────
  it('SHEETS tiene las 4 hojas requeridas', () => {
    expect(SHEETS).toEqual({
      PRODUCTOS: 'Productos',
      COMPRAS: 'Compras',
      VENTAS: 'Ventas',
      RESUMEN: 'Resumen',
    });
  });

  // ── Columnas: Productos ────────────────────────────────────────────
  it('COLUMNS.PRODUCTOS tiene 5 columnas definidas', () => {
    expect(COLUMNS.PRODUCTOS).toHaveLength(5);
  });

  it('COLUMNS.PRODUCTOS incluye nombre (string, editable)', () => {
    const col = COLUMNS.PRODUCTOS.find((c) => c.key === 'nombre');
    expect(col).toBeDefined();
    expect(col!.type).toBe('string');
    expect(col!.readOnly).toBe(false);
  });

  it('COLUMNS.PRODUCTOS incluye stock (number, editable)', () => {
    const col = COLUMNS.PRODUCTOS.find((c) => c.key === 'stock');
    expect(col).toBeDefined();
    expect(col!.type).toBe('number');
    expect(col!.readOnly).toBe(false);
  });

  it('COLUMNS.PRODUCTOS incluye precio_venta (number, editable)', () => {
    const col = COLUMNS.PRODUCTOS.find((c) => c.key === 'precio_venta');
    expect(col).toBeDefined();
    expect(col!.type).toBe('number');
    expect(col!.readOnly).toBe(false);
  });

  it('COLUMNS.PRODUCTOS incluye costo_unitario (number, readonly)', () => {
    const col = COLUMNS.PRODUCTOS.find((c) => c.key === 'costo_unitario');
    expect(col).toBeDefined();
    expect(col!.type).toBe('number');
    expect(col!.readOnly).toBe(true);
  });

  it('COLUMNS.PRODUCTOS incluye ganancia (number, readonly)', () => {
    const col = COLUMNS.PRODUCTOS.find((c) => c.key === 'ganancia');
    expect(col).toBeDefined();
    expect(col!.type).toBe('number');
    expect(col!.readOnly).toBe(true);
  });

  // ── Columnas: Compras ──────────────────────────────────────────────
  it('COLUMNS.COMPRAS tiene 5 columnas definidas', () => {
    expect(COLUMNS.COMPRAS).toHaveLength(5);
  });

  it('COLUMNS.COMPRAS incluye fecha (string)', () => {
    const col = COLUMNS.COMPRAS.find((c) => c.key === 'fecha');
    expect(col).toBeDefined();
    expect(col!.type).toBe('string');
  });

  it('COLUMNS.COMPRAS incluye producto (string)', () => {
    const col = COLUMNS.COMPRAS.find((c) => c.key === 'producto');
    expect(col).toBeDefined();
    expect(col!.type).toBe('string');
  });

  it('COLUMNS.COMPRAS incluye cantidad (number)', () => {
    const col = COLUMNS.COMPRAS.find((c) => c.key === 'cantidad');
    expect(col).toBeDefined();
    expect(col!.type).toBe('number');
  });

  it('COLUMNS.COMPRAS incluye costo_unitario (number)', () => {
    const col = COLUMNS.COMPRAS.find((c) => c.key === 'costo_unitario');
    expect(col).toBeDefined();
    expect(col!.type).toBe('number');
  });

  it('COLUMNS.COMPRAS incluye precio_venta (number, readonly)', () => {
    const col = COLUMNS.COMPRAS.find((c) => c.key === 'precio_venta');
    expect(col).toBeDefined();
    expect(col!.type).toBe('number');
    expect(col!.readOnly).toBe(true);
  });

  // ── Columnas: Ventas ───────────────────────────────────────────────
  it('COLUMNS.VENTAS tiene 5 columnas definidas', () => {
    expect(COLUMNS.VENTAS).toHaveLength(5);
  });

  it('COLUMNS.VENTAS incluye fecha (string)', () => {
    const col = COLUMNS.VENTAS.find((c) => c.key === 'fecha');
    expect(col).toBeDefined();
    expect(col!.type).toBe('string');
  });

  it('COLUMNS.VENTAS incluye producto (string)', () => {
    const col = COLUMNS.VENTAS.find((c) => c.key === 'producto');
    expect(col).toBeDefined();
    expect(col!.type).toBe('string');
  });

  it('COLUMNS.VENTAS incluye cantidad (number)', () => {
    const col = COLUMNS.VENTAS.find((c) => c.key === 'cantidad');
    expect(col).toBeDefined();
    expect(col!.type).toBe('number');
  });

  it('COLUMNS.VENTAS incluye precio_venta (number)', () => {
    const col = COLUMNS.VENTAS.find((c) => c.key === 'precio_venta');
    expect(col).toBeDefined();
    expect(col!.type).toBe('number');
  });

  it('COLUMNS.VENTAS incluye ganancia (number, readonly)', () => {
    const col = COLUMNS.VENTAS.find((c) => c.key === 'ganancia');
    expect(col).toBeDefined();
    expect(col!.type).toBe('number');
    expect(col!.readOnly).toBe(true);
  });

  // ── Columnas: Resumen ──────────────────────────────────────────────
  it('COLUMNS.RESUMEN tiene 2 columnas definidas', () => {
    expect(COLUMNS.RESUMEN).toHaveLength(2);
  });

  it('COLUMNS.RESUMEN incluye metrica (string)', () => {
    const col = COLUMNS.RESUMEN.find((c) => c.key === 'metrica');
    expect(col).toBeDefined();
    expect(col!.type).toBe('string');
  });

  it('COLUMNS.RESUMEN incluye valor (number)', () => {
    const col = COLUMNS.RESUMEN.find((c) => c.key === 'valor');
    expect(col).toBeDefined();
    expect(col!.type).toBe('number');
  });

  // ── Importable columns ─────────────────────────────────────────────
  it('IMPORTABLE_COLUMNS contiene nombre, stock, precio_venta', () => {
    // Must be a tuple type so the compiler enforces the exact values
    expect(IMPORTABLE_COLUMNS).toEqual(['nombre', 'stock', 'precio_venta']);
  });

  it('todas las columnas importables existen en PRODUCTOS', () => {
    const productKeys = new Set(COLUMNS.PRODUCTOS.map((c) => c.key));
    for (const key of IMPORTABLE_COLUMNS) {
      expect(productKeys.has(key)).toBe(true);
    }
  });

  it('ninguna columna importable es readonly', () => {
    for (const key of IMPORTABLE_COLUMNS) {
      const col = COLUMNS.PRODUCTOS.find((c) => c.key === key);
      expect(col?.readOnly).toBe(false);
    }
  });
});
