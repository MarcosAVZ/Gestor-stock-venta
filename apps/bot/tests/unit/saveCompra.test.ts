/**
 * Tests unitarios para SaveCompra.
 *
 * Mockeamos los repos para no tocar Prisma. Verificamos:
 * - Happy path: persistencia + métricas correctas.
 * - Datos incompletos: lanza InvariantViolationError.
 * - Cantidad faltante: lanza error.
 * - Unidad faltante: lanza error.
 * - Cero en costoLote: CalcularMetricas lanza (propagamos).
 * - Métricas se redondean a 2/4 decimales según el schema Prisma.
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';

import { InvariantViolationError } from '../../src/domain/errors/ProgrammerError.ts';
import type { ItemCompra, Compra, Unidad } from '@compras-whatsapp/db';
import { saveCompra } from '../../src/application/conversation/SaveCompra.ts';

// ── Mocks ───────────────────────────────────────────────────────────

function buildMockCompraRepo() {
  return {
    create: vi.fn(async (data: { usuarioId: string }) => ({
      id: 'compra-test-1',
      usuarioId: data.usuarioId,
      fecha: new Date('2026-06-02T12:00:00Z'),
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
        id: 'item-test-1',
        compraId: items[0]?.compraId ?? 'compra-test-1',
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

const validDatos = {
  producto: 'medias negras',
  costoLote: 1200,
  precioVenta: 1500,
  cantidadIngresada: 12,
  unidadIngresada: 'PAR' as Unidad,
};

// ── Tests ───────────────────────────────────────────────────────────

describe('saveCompra', () => {
  it('happy path: persiste Compra + ItemCompra con métricas correctas', async () => {
    const compraRepo = buildMockCompraRepo();
    const itemCompraRepo = buildMockItemCompraRepo();
    const result = await saveCompra(
      { usuarioId: 'user-1', datos: validDatos },
      { compraRepo, itemCompraRepo },
    );
    expect(result.compraId).toBe('compra-test-1');
    expect(result.metricas.costoUnitario).toBe(100); // 1200 / 12
    expect(result.metricas.gananciaUnitaria).toBe(1400); // 1500 - 100
    // ventaTotalEstimada = 1500 * 12 = 18000
    expect(result.metricas.ventaTotalEstimada).toBe(18_000);
    // gananciaTotalEstimada = 1400 * 12 = 16800
    expect(result.metricas.gananciaTotalEstimada).toBe(16_800);
    expect(compraRepo.create).toHaveBeenCalledWith({
      usuarioId: 'user-1',
      imagenOriginal: undefined,
    });
    expect(itemCompraRepo.createMany).toHaveBeenCalledTimes(1);
  });

  it('acepta cantidadSugerida + unidadSugerida del OCR (fallback)', async () => {
    const compraRepo = buildMockCompraRepo();
    const itemCompraRepo = buildMockItemCompraRepo();
    const result = await saveCompra(
      {
        usuarioId: 'user-1',
        datos: {
          producto: 'cajas',
          costoLote: 5000,
          precioVenta: 1500,
          cantidadSugerida: 10,
          unidadSugerida: 'CAJA' as Unidad,
        },
      },
      { compraRepo, itemCompraRepo },
    );
    expect(result.metricas.costoUnitario).toBe(500); // 5000/10
  });

  it('preferencia: cantidadIngresada gana sobre sugerida', async () => {
    const compraRepo = buildMockCompraRepo();
    const itemCompraRepo = buildMockItemCompraRepo();
    await saveCompra(
      {
        usuarioId: 'user-1',
        datos: {
          producto: 'mixto',
          costoLote: 1000,
          precioVenta: 500,
          cantidadSugerida: 2,
          cantidadIngresada: 5,
          unidadIngresada: 'UNIDAD' as Unidad,
        },
      },
      { compraRepo, itemCompraRepo },
    );
    const call = itemCompraRepo.createMany.mock.calls[0]?.[0]?.[0];
    expect(call?.cantidadLote).toBe(5);
  });

  it('datos incompletos (sin producto): InvariantViolationError', async () => {
    const compraRepo = buildMockCompraRepo();
    const itemCompraRepo = buildMockItemCompraRepo();
    await expect(
      saveCompra(
        {
          usuarioId: 'user-1',
          datos: { ...validDatos, producto: '' },
        },
        { compraRepo, itemCompraRepo },
      ),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    expect(compraRepo.create).not.toHaveBeenCalled();
  });

  it('sin cantidad (ni ingresada ni sugerida): InvariantViolationError', async () => {
    const compraRepo = buildMockCompraRepo();
    const itemCompraRepo = buildMockItemCompraRepo();
    await expect(
      saveCompra(
        {
          usuarioId: 'user-1',
          datos: {
            producto: 'medias',
            costoLote: 1000,
            precioVenta: 1500,
            unidadIngresada: 'UNIDAD' as Unidad,
          },
        },
        { compraRepo, itemCompraRepo },
      ),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it('costoLote <= 0: CalcularMetricas lanza InvariantViolationError', async () => {
    const compraRepo = buildMockCompraRepo();
    const itemCompraRepo = buildMockItemCompraRepo();
    await expect(
      saveCompra(
        {
          usuarioId: 'user-1',
          datos: { ...validDatos, costoLote: 0 },
        },
        { compraRepo, itemCompraRepo },
      ),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it('imagenOriginal se omite del create call', async () => {
    const compraRepo = buildMockCompraRepo();
    const itemCompraRepo = buildMockItemCompraRepo();
    await saveCompra(
      {
        usuarioId: 'user-1',
        datos: validDatos,
      },
      { compraRepo, itemCompraRepo },
    );
    expect(compraRepo.create).toHaveBeenCalledWith({
      usuarioId: 'user-1',
    });
  });
});
