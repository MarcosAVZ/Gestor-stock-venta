/**
 * Tests unitarios para ImportService (TDD RED → GREEN → REFACTOR).
 *
 * Verifica que:
 *  - parse() lee Excel, valida filas, genera diff contra productos existentes
 *  - applyChanges() persiste en DB usando $transaction
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';

import { ImportService } from '../../src/application/excel/ImportService.ts';
import { SHEETS, COLUMNS } from '../../src/application/excel/ExcelFormat.ts';
import type { PrismaClientLike } from '../../src/infrastructure/persistence/PrismaClientLike.ts';

// ── Helpers ──────────────────────────────────────────────────────────

function silentLogger(): any {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: () => silentLogger(), level: 'info' };
}

function buildMockPrisma(overrides?: Partial<PrismaClientLike>): any {
  return {
    compra: { create: vi.fn(), findMany: vi.fn() },
    itemCompra: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: any) => fn({} as any)),
    ...overrides,
  } as any;
}

/** Crea un workbook Excel en memoria con la hoja Productos y filas dadas. */
async function buildExcelBuffer(rows: Record<string, unknown>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEETS.PRODUCTOS);

  const headers = COLUMNS.PRODUCTOS.map((c) => c.header);
  ws.columns = headers.map((h) => ({ header: h, key: h }));

  for (const row of rows) {
    ws.addRow(row as any);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ── Fixtures ─────────────────────────────────────────────────────────

const VALID_ROWS = [
  { 'Nombre': 'medias', 'Stock': 100, 'Precio Venta': 1500, 'Costo Unitario': '', 'Ganancia': '' },
  { 'Nombre': 'remeras', 'Stock': 50, 'Precio Venta': 2500, 'Costo Unitario': '', 'Ganancia': '' },
];

const EXISTING_PRODUCTS = [
  { nombre: 'medias', stock: 120, precioVenta: 1500 },
];

// ── Tests ────────────────────────────────────────────────────────────

describe('ImportService', () => {
  let service: ImportService;
  let mockPrisma: ReturnType<typeof buildMockPrisma>;

  beforeEach(() => {
    mockPrisma = buildMockPrisma();
    service = new ImportService(mockPrisma, silentLogger());
  });

  describe('parse', () => {
    it('returns diff with toCreate for new products', async () => {
      mockPrisma.itemCompra.findMany.mockResolvedValue([]);

      const buf = await buildExcelBuffer(VALID_ROWS);
      const result = await service.parse(buf, 'user-1');

      expect(result.invalidRows).toHaveLength(0);
      expect(result.diff.toCreate).toHaveLength(2);
      expect(result.diff.toCreate[0]).toEqual({ nombre: 'medias', stock: 100, precioVenta: 1500 });
      expect(result.diff.toCreate[1]).toEqual({ nombre: 'remeras', stock: 50, precioVenta: 2500 });
    });

    it('detects precio_venta changes for existing products', async () => {
      mockPrisma.itemCompra.findMany.mockResolvedValue([
        { nombre: 'medias', cantidadLote: 100, precioVenta: 1500 },
        { nombre: 'medias', cantidadLote: 20, precioVenta: 2000 },
      ]);

      // precioVenta in Excel is 1500, but latest item has 2000 → no change in diff for precio
      // Actually, let me make a case where precio changes:
      mockPrisma.itemCompra.findMany.mockResolvedValue([
        { nombre: 'medias', cantidadLote: 100, precioVenta: 2000 },
      ]);

      const buf = await buildExcelBuffer([
        { 'Nombre': 'medias', 'Stock': 100, 'Precio Venta': 1500, 'Costo Unitario': '', 'Ganancia': '' },
      ]);
      const result = await service.parse(buf, 'user-1');

      expect(result.diff.toCreate).toHaveLength(0);
      expect(result.diff.toUpdatePrecio).toHaveLength(1);
      expect(result.diff.toUpdatePrecio[0].nombre).toBe('medias');
      expect(result.diff.toUpdatePrecio[0].precioVenta).toBe(1500);
      expect(result.diff.toUpdatePrecio[0].oldPrecio).toBe(2000);
    });

    it('detects stock changes for existing products', async () => {
      mockPrisma.itemCompra.findMany.mockResolvedValue([
        { nombre: 'medias', cantidadLote: 100, precioVenta: 1500 },
        { nombre: 'remeras', cantidadLote: 50, precioVenta: 2500 },
      ]);

      // stock in Excel = 150, current stock = 100 → increase of 50
      const buf = await buildExcelBuffer([
        { 'Nombre': 'medias', 'Stock': 150, 'Precio Venta': 1500, 'Costo Unitario': '', 'Ganancia': '' },
      ]);
      const result = await service.parse(buf, 'user-1');

      expect(result.diff.toUpdateStock).toHaveLength(1);
      expect(result.diff.toUpdateStock[0].nombre).toBe('medias');
      expect(result.diff.toUpdateStock[0].stock).toBe(150);
      expect(result.diff.toUpdateStock[0].oldStock).toBe(100);
      // precio unchanged → NOT in toUpdatePrecio
      expect(result.diff.toUpdatePrecio).toHaveLength(0);
    });

    it('reports invalid rows with empty nombre', async () => {
      mockPrisma.itemCompra.findMany.mockResolvedValue([]);

      const buf = await buildExcelBuffer([
        { 'Nombre': '', 'Stock': 10, 'Precio Venta': 500, 'Costo Unitario': '', 'Ganancia': '' },
      ]);
      const result = await service.parse(buf, 'user-1');

      expect(result.invalidRows).toHaveLength(1);
      expect(result.invalidRows[0].errors).toContain('nombre vacío');
      expect(result.diff.toCreate).toHaveLength(0);
    });

    it('reports invalid rows with stock < 0', async () => {
      mockPrisma.itemCompra.findMany.mockResolvedValue([]);

      const buf = await buildExcelBuffer([
        { 'Nombre': 'medias', 'Stock': -5, 'Precio Venta': 500, 'Costo Unitario': '', 'Ganancia': '' },
      ]);
      const result = await service.parse(buf, 'user-1');

      expect(result.invalidRows).toHaveLength(1);
      expect(result.invalidRows[0].errors).toContain('stock inválido');
    });

    it('reports invalid rows with precio_venta <= 0', async () => {
      mockPrisma.itemCompra.findMany.mockResolvedValue([]);

      const buf = await buildExcelBuffer([
        { 'Nombre': 'medias', 'Stock': 10, 'Precio Venta': 0, 'Costo Unitario': '', 'Ganancia': '' },
      ]);
      const result = await service.parse(buf, 'user-1');

      expect(result.invalidRows).toHaveLength(1);
      expect(result.invalidRows[0].errors).toContain('precio inválido');
    });

    it('mixes valid and invalid rows: valid rows still import, invalid reported', async () => {
      mockPrisma.itemCompra.findMany.mockResolvedValue([]);

      const buf = await buildExcelBuffer([
        { 'Nombre': 'medias', 'Stock': 100, 'Precio Venta': 1500, 'Costo Unitario': '', 'Ganancia': '' },
        { 'Nombre': '', 'Stock': 10, 'Precio Venta': 500, 'Costo Unitario': '', 'Ganancia': '' },
        { 'Nombre': 'remeras', 'Stock': 50, 'Precio Venta': 2500, 'Costo Unitario': '', 'Ganancia': '' },
      ]);
      const result = await service.parse(buf, 'user-1');

      // row 2 (empty nombre) should be invalid
      expect(result.invalidRows).toHaveLength(1);
      expect(result.invalidRows[0].errors).toContain('nombre vacío');

      // valid rows still create
      expect(result.diff.toCreate).toHaveLength(2);
      expect(result.diff.toCreate[0].nombre).toBe('medias');
      expect(result.diff.toCreate[1].nombre).toBe('remeras');
    });

    it('detects both precio and stock change for same product', async () => {
      mockPrisma.itemCompra.findMany.mockResolvedValue([
        { nombre: 'medias', cantidadLote: 100, precioVenta: 2000 },
      ]);

      const buf = await buildExcelBuffer([
        { 'Nombre': 'medias', 'Stock': 150, 'Precio Venta': 1800, 'Costo Unitario': '', 'Ganancia': '' },
      ]);
      const result = await service.parse(buf, 'user-1');

      expect(result.diff.toUpdatePrecio).toHaveLength(1);
      expect(result.diff.toUpdatePrecio[0].oldPrecio).toBe(2000);
      expect(result.diff.toUpdateStock).toHaveLength(1);
      expect(result.diff.toUpdateStock[0].oldStock).toBe(100);
    });

    it('ignores stock decrease (no action needed)', async () => {
      mockPrisma.itemCompra.findMany.mockResolvedValue([
        { nombre: 'medias', cantidadLote: 100, precioVenta: 1500 },
      ]);

      const buf = await buildExcelBuffer([
        { 'Nombre': 'medias', 'Stock': 80, 'Precio Venta': 1500, 'Costo Unitario': '', 'Ganancia': '' },
      ]);
      const result = await service.parse(buf, 'user-1');

      // Stock decreased from 100 to 80 → no stock action
      expect(result.diff.toUpdateStock).toHaveLength(1); // still reports the diff for UI
    });

    it('rejects non-integer stock', async () => {
      mockPrisma.itemCompra.findMany.mockResolvedValue([]);

      const buf = await buildExcelBuffer([
        { 'Nombre': 'medias', 'Stock': 10.5, 'Precio Venta': 500, 'Costo Unitario': '', 'Ganancia': '' },
      ]);
      const result = await service.parse(buf, 'user-1');

      expect(result.invalidRows).toHaveLength(1);
      expect(result.invalidRows[0].errors).toContain('stock inválido');
    });

    it('matches product names case-insensitively', async () => {
      mockPrisma.itemCompra.findMany.mockResolvedValue([
        { nombre: 'MEDIAS', cantidadLote: 100, precioVenta: 1500 },
      ]);

      const buf = await buildExcelBuffer([
        { 'Nombre': 'Medias', 'Stock': 100, 'Precio Venta': 1500, 'Costo Unitario': '', 'Ganancia': '' },
      ]);
      const result = await service.parse(buf, 'user-1');

      // Same name (case-insensitive) → no create
      expect(result.diff.toCreate).toHaveLength(0);
      // Same precio → no update
      expect(result.diff.toUpdatePrecio).toHaveLength(0);
    });

    it('throws for missing headers', async () => {
      mockPrisma.itemCompra.findMany.mockResolvedValue([]);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(SHEETS.PRODUCTOS);
      ws.columns = [{ header: 'Wrong', key: 'Wrong' }];
      ws.addRow({ 'Wrong': 'test' });
      const buf = Buffer.from(await wb.xlsx.writeBuffer());

      await expect(service.parse(buf, 'user-1')).rejects.toThrow(/columnas/);
    });

    it('returns empty diff for empty Productos sheet', async () => {
      mockPrisma.itemCompra.findMany.mockResolvedValue([]);

      const buf = await buildExcelBuffer([]);
      const result = await service.parse(buf, 'user-1');

      expect(result.diff.toCreate).toHaveLength(0);
      expect(result.diff.toUpdatePrecio).toHaveLength(0);
      expect(result.diff.toUpdateStock).toHaveLength(0);
      expect(result.invalidRows).toHaveLength(0);
    });
  });

  describe('applyChanges', () => {
    it('creates Compra + ItemCompra for each toCreate entry', async () => {
      const txMock = {
        compra: { create: vi.fn().mockResolvedValue({ id: 'new-compra-1' }) },
        itemCompra: { createMany: vi.fn() },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await service.applyChanges('user-1', {
        toCreate: [{ nombre: 'medias', stock: 100, precioVenta: 1500 }],
        toUpdatePrecio: [],
        toUpdateStock: [],
      });

      expect(txMock.compra.create).toHaveBeenCalledWith({
        data: { usuarioId: 'user-1' },
      });
      expect(txMock.itemCompra.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            compraId: 'new-compra-1',
            nombre: 'medias',
            cantidadLote: 100,
            precioVenta: expect.any(Number),
            costoLote: expect.any(Number),
          }),
        ],
      });
    });

    it('updates precioVenta on latest ItemCompra for toUpdatePrecio', async () => {
      const txMock = {
        compra: { create: vi.fn() },
        itemCompra: {
          findFirst: vi.fn().mockResolvedValue({ id: 'item-1' }),
          update: vi.fn(),
          createMany: vi.fn(),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await service.applyChanges('user-1', {
        toCreate: [],
        toUpdatePrecio: [{ nombre: 'medias', stock: 100, precioVenta: 1800, oldPrecio: 1500 }],
        toUpdateStock: [],
      });

      expect(txMock.itemCompra.findFirst).toHaveBeenCalledWith({
        where: { nombre: 'medias', compra: { usuarioId: 'user-1' } },
        orderBy: { updatedAt: 'desc' },
      });
      expect(txMock.itemCompra.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { precioVenta: 1800 },
      });
    });

    it('creates ItemCompra with delta for stock increase', async () => {
      const txMock = {
        compra: { create: vi.fn().mockResolvedValue({ id: 'new-compra-2' }) },
        itemCompra: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'item-latest',
            precioVenta: 1500,
            costoLote: 1000,
          }),
          createMany: vi.fn(),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(txMock));

      await service.applyChanges('user-1', {
        toCreate: [],
        toUpdatePrecio: [],
        toUpdateStock: [{ nombre: 'medias', stock: 150, oldStock: 100, precioVenta: 1500 }],
      });

      // Should create a new Compra + ItemCompra with delta = 50
      expect(txMock.compra.create).toHaveBeenCalled();
      expect(txMock.itemCompra.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            nombre: 'medias',
            cantidadLote: 50, // delta = 150 - 100
            precioVenta: 1500,
          }),
        ],
      });
    });

    it('throws when $transaction fails and no changes are applied', async () => {
      mockPrisma.$transaction.mockRejectedValue(new Error('DB error'));

      await expect(
        service.applyChanges('user-1', {
          toCreate: [{ nombre: 'medias', stock: 100, precioVenta: 1500 }],
          toUpdatePrecio: [],
          toUpdateStock: [],
        }),
      ).rejects.toThrow('Error al aplicar cambios');
    });
  });
});
