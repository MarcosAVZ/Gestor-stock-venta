/**
 * Tests for Venta model in Prisma schema.
 *
 * Verifies:
 * - Venta type is exported from @compras-whatsapp/db
 * - Venta has the expected fields
 * - ConversationState enum has VENDIENDO_* values
 */

import { describe, expect, it } from 'vitest';
import { ConversationState, Prisma } from '@compras-whatsapp/db';
import type { Venta } from '@compras-whatsapp/db';

describe('Venta schema', () => {
  it('Venta type is exported and has expected fields', () => {
    // Type-level check: this compiles if Venta has the right shape
    const fakeVenta: Venta = {
      id: 'vnt_1',
      usuarioId: 'usr_abc',
      productoNombre: 'medias negras',
      cantidad: 12,
      precioVenta: new Prisma.Decimal('2500'),
      costoUnitario: new Prisma.Decimal('1500'),
      gananciaUnitaria: new Prisma.Decimal('1000'),
      gananciaTotal: new Prisma.Decimal('12000'),
      fecha: new Date('2026-01-15T00:00:00Z'),
    };
    expect(fakeVenta.id).toBe('vnt_1');
    expect(fakeVenta.usuarioId).toBe('usr_abc');
    expect(fakeVenta.productoNombre).toBe('medias negras');
    expect(fakeVenta.cantidad).toBe(12);
    expect(fakeVenta.fecha).toBeInstanceOf(Date);
  });

  it('Venta fields have correct Prisma Decimal types', () => {
    const fakeVenta: Venta = {
      id: 'vnt_1',
      usuarioId: 'usr_abc',
      productoNombre: 'medias negras',
      cantidad: 12,
      precioVenta: new Prisma.Decimal('2500'),
      costoUnitario: new Prisma.Decimal('1500'),
      gananciaUnitaria: new Prisma.Decimal('1000'),
      gananciaTotal: new Prisma.Decimal('12000'),
      fecha: new Date('2026-01-15T00:00:00Z'),
    };
    expect(fakeVenta.precioVenta).toBeInstanceOf(Prisma.Decimal);
    expect(fakeVenta.costoUnitario).toBeInstanceOf(Prisma.Decimal);
    expect(fakeVenta.gananciaUnitaria).toBeInstanceOf(Prisma.Decimal);
    expect(fakeVenta.gananciaTotal).toBeInstanceOf(Prisma.Decimal);
  });

  it('ConversationState has VENDIENDO_SELECCION', () => {
    expect(ConversationState).toHaveProperty('VENDIENDO_SELECCION');
    expect(ConversationState.VENDIENDO_SELECCION).toBe('VENDIENDO_SELECCION');
  });

  it('ConversationState has VENDIENDO_CANTIDAD', () => {
    expect(ConversationState).toHaveProperty('VENDIENDO_CANTIDAD');
    expect(ConversationState.VENDIENDO_CANTIDAD).toBe('VENDIENDO_CANTIDAD');
  });

  it('ConversationState has VENDIENDO_CONFIRMACION', () => {
    expect(ConversationState).toHaveProperty('VENDIENDO_CONFIRMACION');
    expect(ConversationState.VENDIENDO_CONFIRMACION).toBe('VENDIENDO_CONFIRMACION');
  });

  it('ConversationState has PREGUNTANDO_CANTIDAD_AGREGAR', () => {
    expect(ConversationState).toHaveProperty('PREGUNTANDO_CANTIDAD_AGREGAR');
    expect(ConversationState.PREGUNTANDO_CANTIDAD_AGREGAR).toBe('PREGUNTANDO_CANTIDAD_AGREGAR');
  });

  it('ConversationState has PREGUNTANDO_COSTO_LOTE_AGREGAR', () => {
    expect(ConversationState).toHaveProperty('PREGUNTANDO_COSTO_LOTE_AGREGAR');
    expect(ConversationState.PREGUNTANDO_COSTO_LOTE_AGREGAR).toBe('PREGUNTANDO_COSTO_LOTE_AGREGAR');
  });
});
