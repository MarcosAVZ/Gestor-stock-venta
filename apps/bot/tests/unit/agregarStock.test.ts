/**
 * Tests unitarios para AgregarStock (listarProductos + agregarStock).
 *
 * Mockeamos PrismaClientLike y los repos para no tocar DB.
 * Verificamos:
 * - listarProductos: retorna lista numerada de productos únicos.
 * - listarProductos: retorna array vacío cuando no hay productos.
 * - agregarStock: crea Compra + ItemCompra reutilizando costo/precio.
 * - agregarStock: lanza error con índice inválido.
 * - agregarStock: lanza error con cantidad <= 0.
 * - agregarStock: usa el costo/precio más reciente del producto.
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';

import type { ItemCompra, Compra, Unidad } from '@compras-whatsapp/db';
import { listarProductos, agregarStock } from '../../src/application/conversation/AgregarStock.ts';

// ── Mock factories ────────────────────────────────────────────────────

function buildMockCompraRepo() {
  return {
    create: vi.fn(async (data: { usuarioId: string }) => ({
      id: 'compra-nueva-1',
      usuarioId: data.usuarioId,
      fecha: new Date('2026-06-11T12:00:00Z'),
      moneda: 'ARS' as const,
    } as Compra)),
    findById: vi.fn(),
    findByIdWithItems: vi.fn(),
    findByUsuarioId: vi.fn(),
    findByDateRange: vi.fn(),
    findTopByGanancias: vi.fn(),
  };
}

function buildMockItemCompraRepo() {
  return {
    createMany: vi.fn(async (items: Array<{ compraId: string; nombre: string; cantidadLote: number }>) => [
      {
        id: 'item-nuevo-1',
        compraId: items[0]?.compraId ?? 'compra-nueva-1',
        nombre: items[0]?.nombre ?? '',
        cantidadLote: items[0]?.cantidadLote ?? 0,
        unidad: 'UNIDAD' as Unidad,
        costoLote: new Decimal('1200.00'),
        costoUnitario: new Decimal('100.0000'),
        precioVenta: new Decimal('1500.00'),
        gananciaUnitaria: new Decimal('1400.0000'),
        gananciaTotal: new Decimal('16800.00'),
        updatedAt: new Date(),
      } as unknown as ItemCompra,
    ]),
    findByNombre: vi.fn(),
    findRecentByNombre: vi.fn(),
  };
}

function buildMockPrisma(items: Array<{ nombre: string; costoLote: unknown; precioVenta: unknown; unidad: string }>) {
  return {
    itemCompra: {
      findMany: vi.fn(async () => items),
      createMany: vi.fn(),
      findFirst: vi.fn(),
    },
    compra: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    usuario: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    conversacion: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
  } as any;
}

// ── listarProductos tests ─────────────────────────────────────────────

describe('listarProductos', () => {
  it('retorna lista numerada de productos únicos (deduplicados)', async () => {
    const prisma = buildMockPrisma([
      { nombre: 'medias negras', costoLote: 1200, precioVenta: 1500, unidad: 'PAR' },
      { nombre: 'medias negras', costoLote: 1400, precioVenta: 1600, unidad: 'PAR' }, // duplicado
      { nombre: 'gorras', costoLote: 5000, precioVenta: 8000, unidad: 'UNIDAD' },
    ]);

    const result = await listarProductos('user-1', { prisma });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      indice: 1,
      nombre: 'medias negras',
      costoLote: 1200, // primera aparición (más reciente por orderBy desc)
      precioVenta: 1500,
      unidad: 'PAR',
    });
    expect(result[1]).toEqual({
      indice: 2,
      nombre: 'gorras',
      costoLote: 5000,
      precioVenta: 8000,
      unidad: 'UNIDAD',
    });
  });

  it('retorna array vacío cuando no hay productos', async () => {
    const prisma = buildMockPrisma([]);

    const result = await listarProductos('user-1', { prisma });

    expect(result).toEqual([]);
  });

  it('usa Decimal de Prisma como number (toNumber)', async () => {
    const prisma = buildMockPrisma([
      {
        nombre: 'cajas',
        costoLote: { toNumber: () => 3000 },
        precioVenta: { toNumber: () => 4500 },
        unidad: 'CAJA',
      },
    ]);

    const result = await listarProductos('user-1', { prisma });

    expect(result[0]?.costoLote).toBe(3000);
    expect(result[0]?.precioVenta).toBe(4500);
  });

  it('filtra por usuarioId (la query lo incluye en where)', async () => {
    const prisma = buildMockPrisma([
      { nombre: 'algo', costoLote: 100, precioVenta: 200, unidad: 'UNIDAD' },
    ]);

    await listarProductos('user-42', { prisma });

    expect(prisma.itemCompra.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { compra: { usuarioId: 'user-42' } },
      }),
    );
  });
});

// ── agregarStock tests ────────────────────────────────────────────────

describe('agregarStock', () => {
  it('crea Compra + ItemCompra reutilizando costo/precio del producto', async () => {
    const prisma = buildMockPrisma([
      { nombre: 'medias negras', costoLote: 1200, precioVenta: 1500, unidad: 'PAR' },
    ]);
    const compraRepo = buildMockCompraRepo();
    const itemCompraRepo = buildMockItemCompraRepo();

    await agregarStock(
      { usuarioId: 'user-1', productoIndice: 1, cantidadNueva: 12 },
      { prisma, compraRepo, itemCompraRepo },
    );

    // Verificar que se creó la compra
    expect(compraRepo.create).toHaveBeenCalledWith({ usuarioId: 'user-1' });

    // Verificar que se creó el item con métricas correctas
    expect(itemCompraRepo.createMany).toHaveBeenCalledTimes(1);
    const call = itemCompraRepo.createMany.mock.calls[0]?.[0]?.[0];
    expect(call?.nombre).toBe('medias negras');
    expect(call?.cantidadLote).toBe(12);
    expect(call?.costoLote).toBe('1200.00');
    expect(call?.precioVenta).toBe('1500.00');
    expect(call?.costoUnitario).toBe('100'); // 1200/12 → Decimal.toDecimalPlaces(4).toFixed()
    expect(call?.gananciaUnitaria).toBe('1400'); // 1500 - 100
    expect(call?.gananciaTotal).toBe('16800'); // 1400 * 12
  });

  it('lanza error con índice inválido (no existe)', async () => {
    const prisma = buildMockPrisma([
      { nombre: 'medias negras', costoLote: 1200, precioVenta: 1500, unidad: 'PAR' },
    ]);
    const compraRepo = buildMockCompraRepo();
    const itemCompraRepo = buildMockItemCompraRepo();

    await expect(
      agregarStock(
        { usuarioId: 'user-1', productoIndice: 99, cantidadNueva: 5 },
        { prisma, compraRepo, itemCompraRepo },
      ),
    ).rejects.toThrow('No existe producto con índice 99');

    // No se creó nada
    expect(compraRepo.create).not.toHaveBeenCalled();
    expect(itemCompraRepo.createMany).not.toHaveBeenCalled();
  });

  it('lanza error con cantidad <= 0', async () => {
    const prisma = buildMockPrisma([
      { nombre: 'medias negras', costoLote: 1200, precioVenta: 1500, unidad: 'PAR' },
    ]);
    const compraRepo = buildMockCompraRepo();
    const itemCompraRepo = buildMockItemCompraRepo();

    await expect(
      agregarStock(
        { usuarioId: 'user-1', productoIndice: 1, cantidadNueva: 0 },
        { prisma, compraRepo, itemCompraRepo },
      ),
    ).rejects.toThrow('La cantidad tiene que ser mayor a cero');

    expect(compraRepo.create).not.toHaveBeenCalled();
  });

  it('lanza error con cantidad negativa', async () => {
    const prisma = buildMockPrisma([
      { nombre: 'medias negras', costoLote: 1200, precioVenta: 1500, unidad: 'PAR' },
    ]);
    const compraRepo = buildMockCompraRepo();
    const itemCompraRepo = buildMockItemCompraRepo();

    await expect(
      agregarStock(
        { usuarioId: 'user-1', productoIndice: 1, cantidadNueva: -3 },
        { prisma, compraRepo, itemCompraRepo },
      ),
    ).rejects.toThrow('La cantidad tiene que ser mayor a cero');
  });

  it('lanza error cuando la lista de productos está vacía', async () => {
    const prisma = buildMockPrisma([]);
    const compraRepo = buildMockCompraRepo();
    const itemCompraRepo = buildMockItemCompraRepo();

    await expect(
      agregarStock(
        { usuarioId: 'user-1', productoIndice: 1, cantidadNueva: 5 },
        { prisma, compraRepo, itemCompraRepo },
      ),
    ).rejects.toThrow('No existe producto con índice 1');
  });

  it('usa el costo/precio más reciente del producto (primero tras orderBy desc)', async () => {
    // Two items with same name but different costs — the first one (most recent) is used
    const prisma = buildMockPrisma([
      { nombre: 'gorras', costoLote: 6000, precioVenta: 9000, unidad: 'UNIDAD' },
      { nombre: 'gorras', costoLote: 5000, precioVenta: 8000, unidad: 'UNIDAD' },
    ]);
    const compraRepo = buildMockCompraRepo();
    const itemCompraRepo = buildMockItemCompraRepo();

    await agregarStock(
      { usuarioId: 'user-1', productoIndice: 1, cantidadNueva: 10 },
      { prisma, compraRepo, itemCompraRepo },
    );

    const call = itemCompraRepo.createMany.mock.calls[0]?.[0]?.[0];
    expect(call?.costoLote).toBe('6000.00'); // most recent
    expect(call?.precioVenta).toBe('9000.00'); // most recent
  });
});
