/**
 * Tests unitarios para Vender.ts use case (T4.2 — RED).
 *
 * Verifica:
 * - listarProductosConStock: productos con stock > 0
 * - calcularStock: SUM(cantidadLote) - SUM(cantidad) from Ventas
 * - calcularCostoPromedio: weighted average across all lots
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { listarProductosConStock, calcularStock, calcularCostoPromedio } from '../../src/application/conversation/Vender.ts';

describe('Vender use case', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listarProductosConStock', () => {
    it('returns products with stock > 0', async () => {
      
      const mockVentaRepo = {
        findByProductoNombre: vi.fn().mockImplementation(async (uid: string, nombre: string) => {
          if (nombre === 'medias') return [{ cantidad: 20 }];
          return [];
        }),
      };

      const prisma = {
        itemCompra: {
          groupBy: vi.fn().mockResolvedValue([
            { nombre: 'medias', _sum: { cantidadLote: 100 } },
            { nombre: 'bufandas', _sum: { cantidadLote: 50 } },
          ]),
        },
      };

      const deps = { prisma, ventaRepo: mockVentaRepo };
      const result = await listarProductosConStock('user-1', deps);

      expect(result).toHaveLength(2);
      expect(result[0].nombre).toBe('medias');
      expect(result[0].stock).toBe(80); // 100 - 20
      expect(result[1].nombre).toBe('bufandas');
      expect(result[1].stock).toBe(50);
    });

    it('excludes products with 0 stock', async () => {
      const mockVentaRepo = {
        findByProductoNombre: vi.fn().mockResolvedValue([]),
      };

      const prisma = {
        itemCompra: {
          groupBy: vi.fn().mockResolvedValue([
            { nombre: 'medias', _sum: { cantidadLote: 0 } },
            { nombre: 'bufandas', _sum: { cantidadLote: 50 } },
          ]),
        },
      };

      const deps = { prisma, ventaRepo: mockVentaRepo };
      const result = await listarProductosConStock('user-1', deps);

      expect(result).toHaveLength(1);
      expect(result[0].nombre).toBe('bufandas');
    });
  });

  describe('calcularStock', () => {
    it('calculates stock as SUM(cantidadLote) - SUM(ventas)', async () => {
      const mockVentaRepo = {
        findByProductoNombre: vi.fn().mockResolvedValue([
          { cantidad: 20 },
          { cantidad: 30 },
        ]),
      };

      const prisma = {
        itemCompra: {
          aggregate: vi.fn().mockResolvedValue({ _sum: { cantidadLote: 100 } }),
        },
      };

      const deps = { prisma, ventaRepo: mockVentaRepo };
      const stock = await calcularStock('user-1', 'medias', deps);

      expect(stock).toBe(50); // 100 - 50
    });

    it('returns 0 when no items exist', async () => {
      const mockVentaRepo = {
        findByProductoNombre: vi.fn().mockResolvedValue([]),
      };

      const prisma = {
        itemCompra: {
          aggregate: vi.fn().mockResolvedValue({ _sum: { cantidadLote: 0 } }),
        },
      };

      const deps = { prisma, ventaRepo: mockVentaRepo };
      const stock = await calcularStock('user-1', 'medias', deps);

      expect(stock).toBe(0);
    });
  });

  describe('calcularCostoPromedio', () => {
    it('calculates weighted average cost across all lots', async () => {
      const mockVentaRepo = {
        findByProductoNombre: vi.fn(),
      };

      const prisma = {
        itemCompra: {
          findMany: vi.fn().mockResolvedValue([
            { costoLote: 500, cantidadLote: 100 },
            { costoLote: 300, cantidadLote: 50 },
          ]),
        },
      };

      const deps = { prisma, ventaRepo: mockVentaRepo };
      const costo = await calcularCostoPromedio('user-1', 'medias', deps);

      // (500 + 300) / (100 + 50) = 800 / 150 = 5.3333...
      expect(costo).toBeCloseTo(5.3333, 4);
    });

    it('returns 0 when no items exist', async () => {
      const mockVentaRepo = {
        findByProductoNombre: vi.fn(),
      };

      const prisma = {
        itemCompra: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };

      const deps = { prisma, ventaRepo: mockVentaRepo };
      const costo = await calcularCostoPromedio('user-1', 'medias', deps);

      expect(costo).toBe(0);
    });
  });
});
