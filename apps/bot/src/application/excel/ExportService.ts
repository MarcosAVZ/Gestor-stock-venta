/**
 * @compras-whatsapp/bot — ExportService: genera Excel con datos del usuario.
 *
 * Construye un workbook .xlsx con 4 hojas (Productos, Compras, Ventas, Resumen)
 * usando los formatos definidos en ExcelFormat.ts.
 *
 * Dependencias:
 *   - PrismaClientLike: para queries de datos
 *   - Logger: logging estructurado
 *   - WhatsAppMessagingPort (opcional): para exportAndSend
 */
import ExcelJS from 'exceljs';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import type { Logger } from 'pino';
import type { PrismaClientLike } from '../../infrastructure/persistence/PrismaClientLike.ts';
import type { WhatsAppMessagingPort } from '../../infrastructure/messaging/WhatsAppClient.ts';
import { COLUMNS, SHEETS } from './ExcelFormat.ts';

// ── Helpers ──────────────────────────────────────────────────────────

/** Extrae un número de un valor que puede ser Decimal, string o number. */
function toNumber(d: unknown): number {
  if (typeof d === 'number') return d;
  if (typeof d === 'string') return Number(d);
  if (d !== null && typeof d === 'object' && 'toNumber' in d && typeof (d as { toNumber: () => number }).toNumber === 'function') {
    return (d as { toNumber: () => number }).toNumber();
  }
  return 0;
}

/** Formatea una Date a string ISO corto (YYYY-MM-DD). */
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Tipos internos ───────────────────────────────────────────────────

interface CompraItem {
  nombre: string;
  cantidadLote: number;
  costoLote: unknown;
  costoUnitario: unknown;
  precioVenta: unknown;
  gananciaTotal: unknown;
  updatedAt: Date;
}

interface CompraRaw {
  id: string;
  usuarioId: string;
  fecha: Date;
  items: CompraItem[];
}

interface VentaRaw {
  productoNombre: string;
  cantidad: number;
  precioVenta: unknown;
  costoUnitario: unknown;
  gananciaTotal: unknown;
  createdAt: Date;
}

interface StockInfo {
  stock: number;
  totalPurchased: number;
  totalCost: number;
  latestPrecioVenta: number;
  latestUpdatedAt: Date;
}

// ── Service ──────────────────────────────────────────────────────────

export class ExportService {
  constructor(
    private readonly prisma: PrismaClientLike,
    private readonly logger: Logger,
    private readonly port?: WhatsAppMessagingPort,
  ) {}

  /** Mensaje cuando no hay datos para exportar. */
  static readonly NO_DATA_MESSAGE = 'No hay datos para exportar. Primero cargá algunas compras con /nueva.';

  /**
   * Verifica si el usuario tiene datos para exportar.
   */
  async hasData(usuarioId: string): Promise<boolean> {
    const [compras, ventas] = await this.queryData(usuarioId);
    return compras.length > 0 || ventas.length > 0;
  }

  /**
   * Construye el workbook, lo escribe a un archivo temporal y devuelve el path.
   * El caller es responsable de limpiar el archivo.
   */
  async exportToFile(usuarioId: string): Promise<string> {
    const workbook = new ExcelJS.Workbook();

    // 1. Query data
    const [compras, ventas] = await this.queryData(usuarioId);

    // 2. Calculate stock per product
    const stockMap = this.calculateStock(compras, ventas);

    // 3. Build sheets
    this.buildProductosSheet(workbook, stockMap);
    this.buildComprasSheet(workbook, compras);
    this.buildVentasSheet(workbook, ventas);
    this.buildResumenSheet(workbook, compras, ventas, stockMap);

    // 4. Write to temp file
    const fileName = `export-${crypto.randomUUID()}.xlsx`;
    const filePath = path.join(os.tmpdir(), fileName);
    await workbook.xlsx.writeFile(filePath);

    this.logger.info(
      { event: 'excel_exported', usuarioId, filePath, sheets: workbook.worksheets.length },
      'ExportService: workbook written',
    );

    return filePath;
  }

  /**
   * Construye el Excel, lo envía vía WhatsApp y limpia el archivo temporal.
   * Si no hay datos, envía un mensaje de texto informativo en vez del Excel.
   */
  async exportAndSend(usuarioId: string, chatId: string): Promise<void> {
    if (!this.port) {
      throw new Error('ExportService: WhatsAppMessagingPort no está configurado');
    }

    const tieneDatos = await this.hasData(usuarioId);
    if (!tieneDatos) {
      await this.port.sendText(chatId, ExportService.NO_DATA_MESSAGE);
      this.logger.info(
        { event: 'export_no_data', usuarioId, chatId },
        'ExportService: no data to export, sent info message',
      );
      return;
    }

    const filePath = await this.exportToFile(usuarioId);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await this.port.sendDocument(chatId, filePath, {
        filename: `exportacion_${today}.xlsx`,
        caption: '📊 Todos los datos',
      });
      this.logger.info(
        { event: 'excel_sent', usuarioId, chatId, filePath },
        'ExportService: document sent',
      );
    } finally {
      await fs.unlink(filePath).catch((err) => {
        this.logger.warn(
          { event: 'excel_cleanup_failed', filePath, err: (err as Error).message },
          'ExportService: failed to clean up temp file',
        );
      });
    }
  }

  // ── Data queries ──────────────────────────────────────────────────

  private async queryData(usuarioId: string): Promise<[CompraRaw[], VentaRaw[]]> {
    const [compras, ventas] = await Promise.all([
      this.prisma.compra.findMany({
        where: { usuarioId },
        orderBy: { fecha: 'desc' },
        include: { items: true },
        take: 50,
      }) as Promise<CompraRaw[]>,
      this.prisma.venta.findMany({
        where: { usuarioId },
        orderBy: { createdAt: 'desc' as const },
      }) as Promise<VentaRaw[]>,
    ]);
    return [compras ?? [], ventas ?? []];
  }

  // ── Stock calculation (same pattern as queries/index.ts) ──────────

  private calculateStock(compras: CompraRaw[], ventas: VentaRaw[]): Map<string, StockInfo> {
    const stockMap = new Map<string, StockInfo>();

    for (const c of compras) {
      for (const item of c.items) {
        const current = stockMap.get(item.nombre);
        const costLote = toNumber(item.costoLote);
        const precioVenta = toNumber(item.precioVenta);
        if (current === undefined) {
          stockMap.set(item.nombre, {
            stock: item.cantidadLote,
            totalPurchased: item.cantidadLote,
            totalCost: costLote,
            latestPrecioVenta: precioVenta,
            latestUpdatedAt: item.updatedAt,
          });
        } else {
          current.stock += item.cantidadLote;
          current.totalPurchased += item.cantidadLote;
          current.totalCost += costLote;
          if (item.updatedAt > current.latestUpdatedAt) {
            current.latestPrecioVenta = precioVenta;
            current.latestUpdatedAt = item.updatedAt;
          }
        }
      }
    }

    // Subtract sales
    for (const v of ventas) {
      const current = stockMap.get(v.productoNombre);
      if (current) {
        current.stock -= v.cantidad;
      }
    }

    // Remove products with no stock
    for (const [name, info] of stockMap) {
      if (info.stock <= 0) {
        stockMap.delete(name);
      }
    }

    return stockMap;
  }

  // ── Sheet builders ────────────────────────────────────────────────

  private buildProductosSheet(workbook: ExcelJS.Workbook, stockMap: Map<string, StockInfo>): void {
    const sheet = workbook.addWorksheet(SHEETS.PRODUCTOS);
    const cols = COLUMNS.PRODUCTOS;

    sheet.columns = cols.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.key === 'nombre' ? 30 : 15,
    }));

    for (const [nombre, info] of stockMap) {
      const unitCost = info.totalPurchased > 0 ? info.totalCost / info.totalPurchased : 0;
      const ganancia = info.latestPrecioVenta - unitCost;

      sheet.addRow({
        nombre,
        stock: info.stock,
        precio_venta: info.latestPrecioVenta,
        costo_unitario: Math.round(unitCost * 100) / 100,
        ganancia: Math.round(ganancia * 100) / 100,
      });
    }
  }

  private buildComprasSheet(workbook: ExcelJS.Workbook, compras: CompraRaw[]): void {
    const sheet = workbook.addWorksheet(SHEETS.COMPRAS);
    const cols = COLUMNS.COMPRAS;

    sheet.columns = cols.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.key === 'producto' || c.key === 'fecha' ? 20 : 15,
    }));

    for (const c of compras) {
      for (const item of c.items) {
        sheet.addRow({
          fecha: fmtDate(c.fecha),
          producto: item.nombre,
          cantidad: item.cantidadLote,
          costo_unitario: toNumber(item.costoUnitario),
          precio_venta: toNumber(item.precioVenta),
        });
      }
    }
  }

  private buildVentasSheet(workbook: ExcelJS.Workbook, ventas: VentaRaw[]): void {
    const sheet = workbook.addWorksheet(SHEETS.VENTAS);
    const cols = COLUMNS.VENTAS;

    sheet.columns = cols.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.key === 'producto' || c.key === 'fecha' ? 20 : 15,
    }));

    for (const v of ventas) {
      sheet.addRow({
        fecha: fmtDate(v.createdAt),
        producto: v.productoNombre,
        cantidad: v.cantidad,
        precio_venta: toNumber(v.precioVenta),
        ganancia: toNumber(v.gananciaTotal),
      });
    }
  }

  private buildResumenSheet(
    workbook: ExcelJS.Workbook,
    compras: CompraRaw[],
    ventas: VentaRaw[],
    stockMap: Map<string, StockInfo>,
  ): void {
    const sheet = workbook.addWorksheet(SHEETS.RESUMEN);
    const cols = COLUMNS.RESUMEN;

    sheet.columns = cols.map((c) => ({
      header: c.header,
      key: c.key,
      width: 25,
    }));

    // Calculate metrics
    const totalInvertido = compras.reduce((sum, c) => {
      return sum + c.items.reduce((s, it) => s + toNumber(it.costoLote), 0);
    }, 0);

    const gananciaPotencial = Array.from(stockMap.values()).reduce((sum, info) => {
      const unitCost = info.totalCost / info.stock;
      return sum + (info.stock * info.latestPrecioVenta - info.totalCost);
    }, 0);

    const gananciaRealizada = ventas.reduce((sum, v) => sum + toNumber(v.gananciaTotal), 0);

    const totalProductos = stockMap.size;
    const totalCompras = compras.length;
    const totalVentas = ventas.length;

    sheet.addRow({ metrica: 'total_invertido', valor: totalInvertido });
    sheet.addRow({ metrica: 'ganancia_potencial', valor: Math.round(gananciaPotencial * 100) / 100 });
    sheet.addRow({ metrica: 'ganancia_realizada', valor: Math.round(gananciaRealizada * 100) / 100 });
    sheet.addRow({ metrica: 'total_productos', valor: totalProductos });
    sheet.addRow({ metrica: 'total_compras', valor: totalCompras });
    sheet.addRow({ metrica: 'total_ventas', valor: totalVentas });
  }
}
