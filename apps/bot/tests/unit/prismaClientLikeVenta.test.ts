/**
 * Tests for PrismaClientLike venta delegate.
 *
 * Verifies:
 * - PrismaClientLike has a venta delegate with expected methods
 * - VentaCreateInput type is exported
 */

import { describe, expect, it } from 'vitest';
import type { PrismaClientLike, VentaCreateInput } from '../../src/infrastructure/persistence/PrismaClientLike.ts';

describe('PrismaClientLike venta delegate', () => {
  it('VentaCreateInput type is usable', () => {
    const input: VentaCreateInput = {
      usuarioId: 'usr_abc',
      productoNombre: 'medias negras',
      cantidad: 12,
      precioVenta: '2500.00',
      costoUnitario: '1500.0000',
      gananciaUnitaria: '1000.0000',
      gananciaTotal: '12000.00',
    };
    expect(input.usuarioId).toBe('usr_abc');
  });

  it('PrismaClientLike venta delegate can be mocked', () => {
    const mockVenta = {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    };
    const client = {
      usuario: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
      compra: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
      itemCompra: { createMany: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
      conversacion: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
      venta: mockVenta,
      $queryRaw: vi.fn(),
    } satisfies PrismaClientLike;

    expect(client.venta.create).toBeDefined();
    expect(client.venta.findMany).toBeDefined();
    expect(client.venta.count).toBeDefined();
    expect(client.venta.aggregate).toBeDefined();
  });
});
