/**
 * Tests for PrismaVentaRepository (mocked client).
 *
 * Verifies:
 * - create forwards data to Prisma
 * - findByUsuarioId orders by fecha desc
 * - findByProductoNombre filters by nombre
 * - sumIngresos uses aggregate with _sum
 * - sumGananciaTotal uses aggregate with _sum
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Prisma } from '@compras-whatsapp/db';
import type { Venta } from '@compras-whatsapp/db';

import { PrismaVentaRepository } from '../../src/infrastructure/persistence/PrismaVentaRepository.ts';

// ── Fixtures ─────────────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────

function buildMockVentaClient() {
  return {
    venta: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('PrismaVentaRepository (mocked client)', () => {
  let client: ReturnType<typeof buildMockVentaClient>;
  let repo: PrismaVentaRepository;

  beforeEach(() => {
    client = buildMockVentaClient();
    repo = new PrismaVentaRepository(client as unknown as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('create forwards data to Prisma', async () => {
    client.venta.create.mockResolvedValueOnce(fakeVenta);
    const result = await repo.create({
      usuarioId: 'usr_abc',
      productoNombre: 'medias negras',
      cantidad: 12,
      precioVenta: '2500.00',
      costoUnitario: '1500.0000',
      gananciaUnitaria: '1000.0000',
      gananciaTotal: '12000.00',
    });
    expect(client.venta.create).toHaveBeenCalledWith({
      data: {
        usuarioId: 'usr_abc',
        productoNombre: 'medias negras',
        cantidad: 12,
        precioVenta: '2500.00',
        costoUnitario: '1500.0000',
        gananciaUnitaria: '1000.0000',
        gananciaTotal: '12000.00',
      },
    });
    expect(result).toEqual(fakeVenta);
  });

  test('findByUsuarioId defaults limit to 100 and orders desc by fecha', async () => {
    client.venta.findMany.mockResolvedValueOnce([fakeVenta]);
    await repo.findByUsuarioId('usr_abc');
    expect(client.venta.findMany).toHaveBeenCalledWith({
      where: { usuarioId: 'usr_abc' },
      orderBy: { fecha: 'desc' },
      take: 100,
    });
  });

  test('findByUsuarioId respects custom limit', async () => {
    client.venta.findMany.mockResolvedValueOnce([fakeVenta]);
    await repo.findByUsuarioId('usr_abc', 10);
    expect(client.venta.findMany).toHaveBeenCalledWith({
      where: { usuarioId: 'usr_abc' },
      orderBy: { fecha: 'desc' },
      take: 10,
    });
  });

  test('findByProductoNombre filters by usuarioId and productoNombre', async () => {
    client.venta.findMany.mockResolvedValueOnce([fakeVenta]);
    await repo.findByProductoNombre('usr_abc', 'medias negras');
    expect(client.venta.findMany).toHaveBeenCalledWith({
      where: { usuarioId: 'usr_abc', productoNombre: 'medias negras' },
      orderBy: { fecha: 'desc' },
    });
  });

  test('sumIngresos uses aggregate with _sum on precioVenta * cantidad', async () => {
    client.venta.aggregate.mockResolvedValueOnce({
      _sum: { precioVenta: new Prisma.Decimal('25000') },
    });
    const result = await repo.sumIngresos('usr_abc');
    expect(client.venta.aggregate).toHaveBeenCalledWith({
      where: { usuarioId: 'usr_abc' },
      _sum: { precioVenta: true },
    });
    expect(result).toBe(25000);
  });

  test('sumIngresos returns null when no ventas exist', async () => {
    client.venta.aggregate.mockResolvedValueOnce({ _sum: { precioVenta: null } });
    const result = await repo.sumIngresos('usr_empty');
    expect(result).toBeNull();
  });

  test('sumGananciaTotal uses aggregate with _sum on gananciaTotal', async () => {
    client.venta.aggregate.mockResolvedValueOnce({
      _sum: { gananciaTotal: new Prisma.Decimal('12000') },
    });
    const result = await repo.sumGananciaTotal('usr_abc');
    expect(client.venta.aggregate).toHaveBeenCalledWith({
      where: { usuarioId: 'usr_abc' },
      _sum: { gananciaTotal: true },
    });
    expect(result).toBe(12000);
  });

  test('sumGananciaTotal returns null when no ventas exist', async () => {
    client.venta.aggregate.mockResolvedValueOnce({ _sum: { gananciaTotal: null } });
    const result = await repo.sumGananciaTotal('usr_empty');
    expect(result).toBeNull();
  });
});
