/**
 * Tests unitarios para ExportService (TDD RED → GREEN → REFACTOR).
 *
 * Verifica que ExportService.buildWorkbook (exportToFile) genere el .xlsx
 * con las 4 hojas, headers correctos según ExcelFormat, y datos mapeados
 * correctamente desde las queries mockeadas.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { ExportService } from '../../src/application/excel/ExportService.ts';
import { COLUMNS, SHEETS } from '../../src/application/excel/ExcelFormat.ts';
import type { WhatsAppMessagingPort } from '../../src/infrastructure/messaging/WhatsAppClient.ts';

// ── Helpers ──────────────────────────────────────────────────────────

function silentLogger(): any {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: () => silentLogger(), level: 'info' };
}

/** Builds mock PrismaClientLike with controlled data. */
function buildMockPrisma(data?: {
  compras?: any[];
  ventas?: any[];
}) {
  const compras = data?.compras ?? [];
  const ventas = data?.ventas ?? [];
  return {
    compra: {
      findMany: vi.fn(async () => compras),
    },
    venta: {
      findMany: vi.fn(async () => ventas),
      count: vi.fn(async () => ventas.length),
    },
    itemCompra: {
      findMany: vi.fn(async () => []),
    },
    $queryRaw: vi.fn(),
  } as any;
}

function buildMockPort(): WhatsAppMessagingPort {
  return {
    sendDocument: vi.fn(async () => undefined),
    sendText: vi.fn(),
    sendImage: vi.fn(),
  } as any;
}

/** Lee un workbook desde el filesystem y devuelve sus hojas como arrays de objetos. */
async function readWorkbook(filePath: string): Promise<{
  sheetNames: string[];
  rows: Record<string, any[]>;
  headers: Record<string, string[]>;
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheetNames: string[] = [];
  const rows: Record<string, any[]> = {};
  const headers: Record<string, string[]> = {};

  for (const ws of wb.worksheets) {
    const name = ws.name;
    sheetNames.push(name);

    const allRows: any[] = [];
    const rowValues: any[] = [];

    ws.eachRow((row, rowNumber) => {
      const values = row.values as any[];
      rowValues.push(values);
      if (rowNumber > 1) {
        // Row 1 is header
        const obj: Record<string, any> = {};
        for (let i = 1; i < values.length; i++) {
          obj[`col${i}`] = values[i];
        }
        allRows.push(obj);
      }
    });

    headers[name] = rowValues[0]?.slice(1) ?? [];
    rows[name] = allRows;
  }

  return { sheetNames, rows, headers };
}

// ── Fixtures ─────────────────────────────────────────────────────────

const TWO_COMPRAS = [
  {
    id: 'compra-1',
    usuarioId: 'user-1',
    fecha: new Date('2025-01-15'),
    imagenOriginal: null,
    moneda: 'ARS',
    items: [
      {
        nombre: 'medias',
        cantidadLote: 100,
        unidad: 'PAR',
        costoLote: 10000,
        costoUnitario: 100,
        precioVenta: 200,
        gananciaUnitari: 100,
        gananciaTotal: 10000,
        updatedAt: new Date('2025-01-15'),
      },
      {
        nombre: 'remeras',
        cantidadLote: 50,
        unidad: 'UNIDAD',
        costoLote: 7500,
        costoUnitario: 150,
        precioVenta: 250,
        gananciaUnitari: 100,
        gananciaTotal: 5000,
        updatedAt: new Date('2025-01-15'),
      },
    ],
  },
  {
    id: 'compra-2',
    usuarioId: 'user-1',
    fecha: new Date('2025-02-01'),
    imagenOriginal: null,
    moneda: 'ARS',
    items: [
      {
        nombre: 'medias',
        cantidadLote: 50,
        unidad: 'PAR',
        costoLote: 5500,
        costoUnitario: 110,
        precioVenta: 200,
        gananciaUnitari: 90,
        gananciaTotal: 4500,
        updatedAt: new Date('2025-02-01'),
      },
    ],
  },
];

const TWO_VENTAS = [
  {
    id: 'venta-1',
    usuarioId: 'user-1',
    productoNombre: 'medias',
    cantidad: 30,
    precioVenta: 200,
    costoUnitario: 103.33,
    gananciaUnitaria: 96.67,
    gananciaTotal: 2900.1,
    fecha: new Date('2025-01-20'),
  },
  {
    id: 'venta-2',
    usuarioId: 'user-1',
    productoNombre: 'remeras',
    cantidad: 20,
    precioVenta: 250,
    costoUnitario: 150,
    gananciaUnitaria: 100,
    gananciaTotal: 2000,
    fecha: new Date('2025-01-25'),
  },
];

// ── Tests ────────────────────────────────────────────────────────────

describe('ExportService', () => {
  let service: ExportService;
  let mockPrisma: ReturnType<typeof buildMockPrisma>;
  let mockPort: WhatsAppMessagingPort;
  let tempFiles: string[];

  beforeEach(() => {
    mockPort = buildMockPort();
    mockPrisma = buildMockPrisma({ compras: TWO_COMPRAS, ventas: TWO_VENTAS });
    service = new ExportService(mockPrisma, silentLogger(), mockPort);
    tempFiles = [];
  });

  afterEach(async () => {
    // Clean up any temp files that were created
    for (const fp of tempFiles) {
      await fs.unlink(fp).catch(() => {});
    }
  });

  // ── exportToFile ──────────────────────────────────────────────────

  describe('exportToFile', () => {
    it('creates workbook with all 4 sheets named correctly', async () => {
      const filePath = await service.exportToFile('user-1');
      tempFiles.push(filePath);

      const { sheetNames } = await readWorkbook(filePath);
      expect(sheetNames).toEqual([
        SHEETS.PRODUCTOS,
        SHEETS.COMPRAS,
        SHEETS.VENTAS,
        SHEETS.RESUMEN,
      ]);
    });

    it('writes Productos headers from ExcelFormat', async () => {
      const filePath = await service.exportToFile('user-1');
      tempFiles.push(filePath);

      const { headers } = await readWorkbook(filePath);
      const expectedHeaders = COLUMNS.PRODUCTOS.map((c) => c.header);
      expect(headers[SHEETS.PRODUCTOS]).toEqual(expectedHeaders);
    });

    it('writes Compras headers from ExcelFormat', async () => {
      const filePath = await service.exportToFile('user-1');
      tempFiles.push(filePath);

      const { headers } = await readWorkbook(filePath);
      const expectedHeaders = COLUMNS.COMPRAS.map((c) => c.header);
      expect(headers[SHEETS.COMPRAS]).toEqual(expectedHeaders);
    });

    it('writes Ventas headers from ExcelFormat', async () => {
      const filePath = await service.exportToFile('user-1');
      tempFiles.push(filePath);

      const { headers } = await readWorkbook(filePath);
      const expectedHeaders = COLUMNS.VENTAS.map((c) => c.header);
      expect(headers[SHEETS.VENTAS]).toEqual(expectedHeaders);
    });

    it('writes Resumen headers from ExcelFormat', async () => {
      const filePath = await service.exportToFile('user-1');
      tempFiles.push(filePath);

      const { headers } = await readWorkbook(filePath);
      const expectedHeaders = COLUMNS.RESUMEN.map((c) => c.header);
      expect(headers[SHEETS.RESUMEN]).toEqual(expectedHeaders);
    });

    it('writes Productos rows with stock > 0 using calculated stock', async () => {
      const filePath = await service.exportToFile('user-1');
      tempFiles.push(filePath);

      const { rows } = await readWorkbook(filePath);
      const productosRows = rows[SHEETS.PRODUCTOS];

      // medias: 100+50-30 = 120 stock, unit cost ~103.33, price 200
      // remeras: 50-20 = 30 stock
      expect(productosRows).toHaveLength(2);

      const mediasRow = productosRows.find((r) => r.col1 === 'medias');
      expect(mediasRow).toBeDefined();
      expect(mediasRow!.col2).toBe(120); // stock
      expect(mediasRow!.col3).toBe(200); // precio_venta
      expect(mediasRow!.col5).toBeCloseTo(96.67, 0); // ganancia

      const remerasRow = productosRows.find((r) => r.col1 === 'remeras');
      expect(remerasRow).toBeDefined();
      expect(remerasRow!.col2).toBe(30); // stock
    });

    it('writes Compras rows with last 50 compras items', async () => {
      const filePath = await service.exportToFile('user-1');
      tempFiles.push(filePath);

      const { rows } = await readWorkbook(filePath);
      const comprasRows = rows[SHEETS.COMPRAS];

      // We have 3 items total across 2 compras
      expect(comprasRows).toHaveLength(3);

      // Check first item
      const firstFecha = comprasRows[0].col1;
      expect(typeof firstFecha).toBe('string');
      expect(firstFecha.length).toBeGreaterThan(0);
    });

    it('writes Ventas rows with all ventas', async () => {
      const filePath = await service.exportToFile('user-1');
      tempFiles.push(filePath);

      const { rows } = await readWorkbook(filePath);
      const ventasRows = rows[SHEETS.VENTAS];

      expect(ventasRows).toHaveLength(2);

      const mediasVenta = ventasRows.find((r) => r.col2 === 'medias');
      expect(mediasVenta).toBeDefined();
      expect(mediasVenta!.col3).toBe(30); // cantidad
      expect(mediasVenta!.col4).toBe(200); // precio_venta
      expect(mediasVenta!.col5).toBeCloseTo(2900.1, 0); // ganancia
    });

    it('writes Resumen rows with calculated metrics', async () => {
      const filePath = await service.exportToFile('user-1');
      tempFiles.push(filePath);

      const { rows } = await readWorkbook(filePath);
      const resumenRows = rows[SHEETS.RESUMEN];

      // Should have 6 metric rows
      expect(resumenRows).toHaveLength(6);

      const metrics = resumenRows.reduce((acc: Record<string, number>, r: any) => {
        acc[r.col1] = r.col2;
        return acc;
      }, {});

      expect(metrics['total_invertido']).toBe(23000); // 10000 + 7500 + 5500
      expect(metrics['total_productos']).toBe(2); // medias + remeras with stock > 0
      expect(metrics['total_compras']).toBe(2);
      expect(metrics['total_ventas']).toBe(2);
    });

    it('handles empty data gracefully (no compras, no ventas)', async () => {
      const emptyPrisma = buildMockPrisma({ compras: [], ventas: [] });
      const emptyService = new ExportService(emptyPrisma, silentLogger(), buildMockPort());

      const filePath = await emptyService.exportToFile('user-1');
      tempFiles.push(filePath);

      const { rows } = await readWorkbook(filePath);
      expect(rows[SHEETS.PRODUCTOS]).toHaveLength(0);
      expect(rows[SHEETS.COMPRAS]).toHaveLength(0);
      expect(rows[SHEETS.VENTAS]).toHaveLength(0);

      // Resumen should have all zeros
      const resumenRows = rows[SHEETS.RESUMEN];
      expect(resumenRows).toHaveLength(6);
      for (const r of resumenRows) {
        expect(r.col2).toBe(0);
      }
    });

    it('returns a valid file path that exists on disk', async () => {
      const filePath = await service.exportToFile('user-1');
      tempFiles.push(filePath);

      await expect(fs.access(filePath)).resolves.toBeUndefined();
      expect(filePath).toMatch(/\.xlsx$/);
    });
  });

  // ── hasData ────────────────────────────────────────────────────────

  describe('hasData', () => {
    it('returns true when there are compras', async () => {
      const result = await service.hasData('user-1');
      expect(result).toBe(true);
    });

    it('returns true when there are only ventas (no compras)', async () => {
      const onlyVentas = buildMockPrisma({ compras: [], ventas: TWO_VENTAS });
      const svc = new ExportService(onlyVentas, silentLogger(), mockPort);
      const result = await svc.hasData('user-1');
      expect(result).toBe(true);
    });

    it('returns false when there are no compras and no ventas', async () => {
      const empty = buildMockPrisma({ compras: [], ventas: [] });
      const svc = new ExportService(empty, silentLogger(), mockPort);
      const result = await svc.hasData('user-1');
      expect(result).toBe(false);
    });
  });

  // ── exportAndSend ─────────────────────────────────────────────────

  describe('exportAndSend', () => {
    it('sends text message when there is no data', async () => {
      const emptyPrisma = buildMockPrisma({ compras: [], ventas: [] });
      const emptySvc = new ExportService(emptyPrisma, silentLogger(), mockPort);

      await emptySvc.exportAndSend('user-1', 'chat-1@c.us');

      expect(mockPort.sendDocument).not.toHaveBeenCalled();
      expect(mockPort.sendText).toHaveBeenCalledWith(
        'chat-1@c.us',
        ExportService.NO_DATA_MESSAGE,
      );
    });

    it('sends document via port and cleans up temp file', async () => {
      const filePath = await service.exportToFile('user-1');
      // Mock exportToFile to return a known path so we can check cleanup
      vi.spyOn(service, 'exportToFile').mockResolvedValue(filePath);

      await service.exportAndSend('user-1', 'chat-1@c.us');

      expect(mockPort.sendDocument).toHaveBeenCalledWith(
        'chat-1@c.us',
        filePath,
        expect.objectContaining({ filename: expect.stringMatching(/^exportacion_\d{4}-\d{2}-\d{2}\.xlsx$/) }),
      );

      // File should be cleaned up
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('cleans up temp file even when sendDocument throws', async () => {
      const filePath = await service.exportToFile('user-1');
      vi.spyOn(service, 'exportToFile').mockResolvedValue(filePath);
      vi.mocked(mockPort.sendDocument).mockRejectedValue(new Error('send failed'));

      await expect(
        service.exportAndSend('user-1', 'chat-1@c.us'),
      ).rejects.toThrow('send failed');

      // File should still be cleaned up
      await expect(fs.access(filePath)).rejects.toThrow();
    });
  });
});
