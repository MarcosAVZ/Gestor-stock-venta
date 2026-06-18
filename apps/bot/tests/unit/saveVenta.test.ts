/**
 * Tests unitarios para saveVenta.ts (T4.4 — RED).
 *
 * Verifica:
 * - saveVenta: crea Venta record con costoUnitario, gananciaUnitaria, gananciaTotal
 * - saveVenta: calcula ganancia correctamente
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { saveVenta } from '../../src/application/conversation/saveVenta.ts';

describe('saveVenta use case', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('saveVenta', () => {
    it('creates Venta record with correct calculations', async () => {
      
      const mockVentaRepo = {
        create: vi.fn().mockResolvedValue({ id: 'venta-1' }),
      };

      const deps = { ventaRepo: mockVentaRepo };
      const datos = {
        productoNombre: 'medias',
        cantidad: 10,
        precioVentaUnitario: 15,
        costoUnitarioPromedio: 5,
      };

      await saveVenta('user-1', datos, deps);

      expect(mockVentaRepo.create).toHaveBeenCalledWith({
        usuarioId: 'user-1',
        productoNombre: 'medias',
        cantidad: 10,
        precioVenta: '150.00', // 10 * 15
        costoUnitario: '5.0000',
        gananciaUnitaria: '10.0000', // 15 - 5
        gananciaTotal: '100.00', // 10 * (15 - 5)
      });
    });

    it('calculates ganancia correctly for different values', async () => {
      const mockVentaRepo = {
        create: vi.fn().mockResolvedValue({ id: 'venta-2' }),
      };

      const deps = { ventaRepo: mockVentaRepo };
      const datos = {
        productoNombre: 'bufandas',
        cantidad: 5,
        precioVentaUnitario: 20,
        costoUnitarioPromedio: 12.5,
      };

      await saveVenta('user-2', datos, deps);

      expect(mockVentaRepo.create).toHaveBeenCalledWith({
        usuarioId: 'user-2',
        productoNombre: 'bufandas',
        cantidad: 5,
        precioVenta: '100.00', // 5 * 20
        costoUnitario: '12.5000',
        gananciaUnitaria: '7.5000', // 20 - 12.5
        gananciaTotal: '37.50', // 5 * (20 - 12.5)
      });
    });
  });
});
