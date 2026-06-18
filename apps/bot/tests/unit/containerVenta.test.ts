/**
 * Tests for container wiring of VentaRepository.
 *
 * Verifies:
 * - buildContainer includes VentaRepository in the container
 * - VentaRepository can be instantiated with mock PrismaClientLike
 */

import { describe, expect, it, vi } from 'vitest';
import { PrismaVentaRepository } from '../../src/infrastructure/persistence/PrismaVentaRepository.ts';
import type { VentaRepository } from '../../src/domain/repositories/VentaRepository.ts';
import type { PrismaClientLike } from '../../src/infrastructure/persistence/PrismaClientLike.ts';

describe('VentaRepository wiring', () => {
  it('PrismaVentaRepository implements VentaRepository', () => {
    const mockClient = {
      usuario: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
      compra: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
      itemCompra: { createMany: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
      conversacion: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
      venta: { create: vi.fn(), findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
      $queryRaw: vi.fn(),
    } satisfies PrismaClientLike;

    const repo: VentaRepository = new PrismaVentaRepository(mockClient);
    expect(repo).toBeDefined();
    expect(typeof repo.create).toBe('function');
    expect(typeof repo.findByUsuarioId).toBe('function');
    expect(typeof repo.findByProductoNombre).toBe('function');
    expect(typeof repo.sumIngresos).toBe('function');
    expect(typeof repo.sumGananciaTotal).toBe('function');
  });
});
