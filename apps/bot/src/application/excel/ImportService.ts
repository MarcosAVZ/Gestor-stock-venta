/**
 * @compras-whatsapp/bot — ImportService: parsea Excel y aplica cambios.
 *
 * RESPONSABILIDAD:
 * - parse(): Lee un buffer Excel, valida hoja Productos, genera diff
 *   contra productos existentes en DB.
 * - applyChanges(): Aplica el diff en una transacción Prisma.
 *
 * Dependencias:
 *   - PrismaClientLike: para queries de datos y transacciones
 *   - Logger: logging estructurado
 */
import ExcelJS from 'exceljs';

import type { Logger } from 'pino';
import type { PrismaClientLike } from '../../infrastructure/persistence/PrismaClientLike.ts';
import { COLUMNS, SHEETS, IMPORTABLE_COLUMNS } from './ExcelFormat.ts';

// ── Types ─────────────────────────────────────────────────────────────

export interface ImportRow {
  nombre: string;
  stock: number;
  precioVenta: number;
}

export interface UpdatePrecioRow extends ImportRow {
  oldPrecio: number;
}

export interface UpdateStockRow extends ImportRow {
  oldStock: number;
}

export interface ImportDiff {
  toCreate: ImportRow[];
  toUpdatePrecio: UpdatePrecioRow[];
  toUpdateStock: UpdateStockRow[];
}

export interface InvalidRow {
  row: number; // 1-based Excel row number
  errors: string[];
}

export interface ParseResult {
  diff: ImportDiff;
  invalidRows: InvalidRow[];
}

// ── Service ───────────────────────────────────────────────────────────

export class ImportService {
  constructor(
    private readonly prisma: PrismaClientLike,
    private readonly logger: Logger,
  ) {}

  /**
   * Lee un buffer Excel, valida la hoja Productos y genera un diff
   * contra los productos existentes del usuario.
   */
  async parse(buffer: Buffer, usuarioId: string): Promise<ParseResult> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheet = workbook.getWorksheet(SHEETS.PRODUCTOS);
    if (!sheet) {
      throw new Error(`No se encontró la hoja "${SHEETS.PRODUCTOS}"`);
    }

    // 1. Validate headers
    const expectedHeaders = COLUMNS.PRODUCTOS.map((c) => c.header);
    const actualHeaders: string[] = [];
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => actualHeaders.push(String(cell.value ?? '')));

    // Normalize comparison: lowercase, trimmed
    const normExpected = expectedHeaders.map((h) => h.toLowerCase().trim());
    const normActual = actualHeaders.map((h) => h.toLowerCase().trim());

    const missing = normExpected.filter((h) => !normActual.includes(h));
    if (missing.length > 0) {
      throw new Error(`Faltan columnas: ${missing.join(', ')}.`);
    }

    // 2. Build header index map (lowercased header → column index 0-based)
    const headerIndex = new Map<string, number>();
    for (let i = 0; i < actualHeaders.length; i++) {
      headerIndex.set(actualHeaders[i].toLowerCase().trim(), i);
    }

    const nameIdx = headerIndex.get('nombre');
    const stockIdx = headerIndex.get('stock');
    const priceIdx = headerIndex.get('precio venta');

    // 3. Parse rows (skip header row)
    const rows: ImportRow[] = [];
    const invalidRows: InvalidRow[] = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // skip header
      const values = row.values as unknown[];
      // values is 1-indexed array, so value at index 1 = column A

      const getCell = (colIndex: number | undefined): string => {
        if (colIndex === undefined) return '';
        const v = values[colIndex + 1]; // +1 because row.values is 1-indexed
        if (v === null || v === undefined) return '';
        return String(v).trim();
      };

      const nombre = getCell(nameIdx);
      const stockStr = getCell(stockIdx);
      const precioStr = getCell(priceIdx);

      const errors: string[] = [];

      if (!nombre) errors.push('nombre vacío');

      const stock = Number(stockStr);
      if (isNaN(stock) || stock < 0 || !Number.isInteger(stock)) {
        errors.push('stock inválido');
      }

      const precioVenta = Number(precioStr);
      if (isNaN(precioVenta) || precioVenta <= 0) {
        errors.push('precio inválido');
      }

      if (errors.length > 0) {
        invalidRows.push({ row: rowNumber, errors });
        return;
      }

      rows.push({ nombre: nombre.toLowerCase(), stock, precioVenta });
    });

    // 4. Query existing products for this user to determine diff
    const existingItems = await this.prisma.itemCompra.findMany({
      where: { compra: { usuarioId } },
      orderBy: { updatedAt: 'desc' },
      select: { nombre: true, cantidadLote: true, precioVenta: true },
    }) as Array<{ nombre: string; cantidadLote: unknown; precioVenta: unknown }>;

    // Build map of existing products: normalized name → current stock & latest precioVenta
    const existingMap = new Map<string, { totalStock: number; latestPrecioVenta: number }>();
    const seenForStock = new Set<string>();
    for (const item of existingItems) {
      const name = item.nombre.toLowerCase();
      const cantidad = Number(item.cantidadLote);
      const precio = Number(item.precioVenta);

      // Accumulate total stock
      const current = existingMap.get(name);
      if (current) {
        current.totalStock += isNaN(cantidad) ? 0 : cantidad;
      } else {
        existingMap.set(name, { totalStock: isNaN(cantidad) ? 0 : cantidad, latestPrecioVenta: isNaN(precio) ? 0 : precio });
      }
    }

    // 5. Build diff
    const diff: ImportDiff = {
      toCreate: [],
      toUpdatePrecio: [],
      toUpdateStock: [],
    };

    for (const row of rows) {
      const existing = existingMap.get(row.nombre);
      if (!existing) {
        // New product
        diff.toCreate.push(row);
      } else {
        // Existing product — check precio and stock
        if (row.precioVenta !== existing.latestPrecioVenta) {
          diff.toUpdatePrecio.push({ ...row, oldPrecio: existing.latestPrecioVenta });
        }
        if (row.stock !== existing.totalStock) {
          diff.toUpdateStock.push({ ...row, oldStock: existing.totalStock });
        }
      }
    }

    this.logger.info(
      { event: 'import_parsed', usuarioId, toCreate: diff.toCreate.length, toUpdatePrecio: diff.toUpdatePrecio.length, toUpdateStock: diff.toUpdateStock.length, invalidRows: invalidRows.length },
      'ImportService: Excel parsed',
    );

    return { diff, invalidRows };
  }

  /**
   * Aplica el diff en una transacción Prisma.
   * NEW products → INSERT Compra + ItemCompra (costoLote default = 70% of precioVenta)
   * Precio change → UPDATE most recent ItemCompra
   * Stock increase → INSERT ItemCompra with delta
   * Stock decrease → no action
   */
  async applyChanges(usuarioId: string, diff: ImportDiff): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx: any) => {
        for (const row of diff.toCreate) {
          await this.createItemCompra(tx, usuarioId, row.nombre, row.stock, row.precioVenta);
        }

        for (const row of diff.toUpdatePrecio) {
          const latest = await tx.itemCompra.findFirst({
            where: { nombre: row.nombre, compra: { usuarioId } },
            orderBy: { updatedAt: 'desc' },
          }) as { id: string } | null;
          if (latest) {
            await tx.itemCompra.update({
              where: { id: latest.id },
              data: { precioVenta: row.precioVenta },
            });
          }
        }

        for (const row of diff.toUpdateStock) {
          if (row.stock <= row.oldStock) continue; // stock decrease: no action

          const delta = row.stock - row.oldStock;
          // Find latest precioVenta for this product to use in new ItemCompra
          const latest = await tx.itemCompra.findFirst({
            where: { nombre: row.nombre, compra: { usuarioId } },
            orderBy: { updatedAt: 'desc' },
          }) as { precioVenta: number } | null;

          const precioVenta = latest ? latest.precioVenta : row.precioVenta;
          await this.createItemCompra(tx, usuarioId, row.nombre, delta, precioVenta);
        }
      });

      this.logger.info(
        { event: 'import_applied', usuarioId, created: diff.toCreate.length, updatedPrecio: diff.toUpdatePrecio.length, updatedStock: diff.toUpdateStock.length },
        'ImportService: changes applied',
      );
    } catch (err) {
      this.logger.error(
        { event: 'import_apply_failed', usuarioId, err: (err as Error).message },
        'ImportService: transaction failed',
      );
      throw new Error('Error al aplicar cambios. No se modificó nada.');
    }
  }

  /**
   * Crea una Compra + ItemCompra con los datos dados.
   * costoLote default = 70% of precioVenta.
   */
  private async createItemCompra(
    tx: any,
    usuarioId: string,
    nombre: string,
    cantidad: number,
    precioVenta: number,
  ): Promise<void> {
    const compra = await tx.compra.create({
      data: { usuarioId },
    });

    const costoLote = cantidad > 0
      ? Math.round(precioVenta * 0.7 * 100) / 100
      : 0;
    const costoUnitario = cantidad > 0
      ? Math.round((costoLote / cantidad) * 100) / 100
      : 0;
    const gananciaUnitaria = cantidad > 0
      ? Math.round((precioVenta - (costoLote / cantidad)) * 100) / 100
      : 0;
    const gananciaTotal = Math.round((precioVenta * cantidad - costoLote) * 100) / 100;

    await tx.itemCompra.createMany({
      data: [{
        compraId: compra.id,
        nombre,
        cantidadLote: cantidad,
        unidad: 'UNIDAD',
        costoLote,
        costoUnitario,
        precioVenta,
        gananciaUnitaria,
        gananciaTotal,
      }],
    });
  }
}
