/**
 * @compras-whatsapp/bot — 5 query use cases consolidados (mejora-visual-estadisticas).
 *
 * Transforma 12 comandos de consulta en 5 con formato visual emoji-estructurado.
 *
 * Comandos:
 *   1. estadisticas — Todo en un solo mensaje (reemplaza resumen, estadisticas,
 *      ganancias, ingresos, ganancia realizada, ganancia potencial, costo promedio)
 *   2. productos — Lista de productos con stock (reemplaza productos + stock)
 *   3. producto <nombre> — Detalle con fuzzy match (sin cambios funcionales)
 *   4. compras — Compras del mes (reemplaza compras mes / compras-mes / compras del mes)
 *   5. top — Top productos por ganancia (reemplaza top ganancias)
 *
 * Aliases backward compatibles: todos los nombres viejos siguen funcionando.
 */
import type { ItemCompra, GrupoProducto } from '@compras-whatsapp/db';
import type { Logger } from 'pino';

import { logSecurityEvent } from '../../infrastructure/logging/logger.ts';
import type { PrismaClientLike } from '../../infrastructure/persistence/PrismaClientLike.ts';

// ── Helpers compartidos ──────────────────────────────────────────────

type AnyLogger = Logger;

/** Mensaje estándar cuando la DB está vacía para el usuario. */
const EMPTY_DB_MESSAGE = 'Todavía no cargaste compras. Usá /nueva para empezar.';

/** Helper para formatear números en pesos AR (1.500, 1.500,50). */
function fmtArs(n: number | string | { toNumber: () => number }): string {
  let num: number;
  if (typeof n === 'number') num = n;
  else if (typeof n === 'string') num = Number(n);
  else num = n.toNumber();
  return num.toLocaleString('es-AR', { maximumFractionDigits: 2 });
}

/** Helper para extraer un numero de un Decimal de Prisma. */
function toNumber(d: unknown): number {
  if (typeof d === 'number') return d;
  if (typeof d === 'string') return Number(d);
  if (d !== null && typeof d === 'object' && 'toNumber' in d && typeof (d as { toNumber: () => number }).toNumber === 'function') {
    return (d as { toNumber: () => number }).toNumber();
  }
  return 0;
}

/** Rango de fechas del mes actual en timezone local. */
function currentMonthRange(now: Date = new Date()): { from: Date; to: Date } {
  const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { from, to };
}

/** Pluralización simple en español. */
function plural(n: number, singular: string, pluralStr: string): string {
  return n === 1 ? singular : pluralStr;
}

// ── Tipos de input compartidos ───────────────────────────────────────

export interface QueryDeps {
  prisma: PrismaClientLike;
  logger: AnyLogger;
}

// ── 5 tipos de comando (reemplazan los 12 anteriores) ────────────────

export type QueryCommand =
  | { type: 'estadisticas' }
  | { type: 'productos' }
  | { type: 'producto'; nombre: string }
  | { type: 'compras' }
  | { type: 'top' }
  | { type: 'grupo'; nombre?: string };

// ── Alias map + parse ────────────────────────────────────────────────

export function parseQueryCommand(input: string): QueryCommand | null {
  const text = input.trim().toLowerCase();

  // Aliases que resuelven a 'estadisticas'
  if (
    text === 'resumen' ||
    text === 'estadisticas' ||
    text === 'estadísticas' ||
    text === 'ganancias' ||
    text === 'ingresos' ||
    text === 'ganancia realizada' ||
    text === 'ganancia potencial' ||
    text === 'costo promedio'
  ) {
    return { type: 'estadisticas' };
  }

  // Aliases que resuelven a 'productos'
  if (text === 'productos' || text === 'stock') {
    return { type: 'productos' };
  }

  // Aliases que resuelven a 'compras'
  if (
    text === 'compras' ||
    text === 'compras mes' ||
    text === 'compras-mes' ||
    text === 'compras del mes'
  ) {
    return { type: 'compras' };
  }

  // Aliases que resuelven a 'top'
  if (text === 'top' || text === 'top ganancias') {
    return { type: 'top' };
  }

  // producto <nombre>
  if (text.startsWith('producto ')) {
    const nombre = text.slice('producto '.length).trim();
    if (nombre.length > 0) return { type: 'producto', nombre };
  }

  // grupo (bare) → list groups for selection
  if (text === 'grupo') {
    return { type: 'grupo' };
  }

  // grupo <nombre>
  if (text.startsWith('grupo ')) {
    const nombre = text.slice('grupo '.length).trim();
    if (nombre.length > 0) return { type: 'grupo', nombre: nombre.toLowerCase() };
  }

  return null;
}

// ── 1. estadisticas ──────────────────────────────────────────────────

/**
 * Mensaje consolidado con 3 secciones:
 * ▫️ Este mes — compras del mes, invertido, ganancia potencial
 * ▫️ Totales — compras totales, items, ticket promedio
 * ▫️ Ventas — ingresos, ganancia realizada, ganancia potencial restante, costo promedio
 *
 * Solo muestra la sección Ventas si el usuario tiene ventas registradas.
 */
export async function getEstadisticas(
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const [compras, ventas] = await Promise.all([
      deps.prisma.compra.findMany({
        where: { usuarioId },
        include: { items: true },
      }) as Promise<Array<{
        id: string;
        fecha: Date;
        items: Array<{
          nombre: string;
          cantidadLote: number;
          costoLote: unknown;
          gananciaTotal: unknown;
          precioVenta: unknown;
          updatedAt: Date;
        }>;
      }>>,
      deps.prisma.venta.findMany({
        where: { usuarioId },
      }) as Promise<Array<{
        productoNombre: string;
        cantidad: number;
        precioVenta: unknown;
        gananciaTotal: unknown;
      }>>,
    ]);

    if (compras.length === 0) return EMPTY_DB_MESSAGE;

    const { from, to } = currentMonthRange();
    const monthCompras = compras.filter((c) => c.fecha >= from && c.fecha <= to);

    // ── Este mes ──
    let mesInvertido = 0;
    let mesGanancia = 0;
    for (const c of monthCompras) {
      for (const it of c.items) {
        mesInvertido += toNumber(it.costoLote);
        mesGanancia += toNumber(it.gananciaTotal);
      }
    }

    // ── Totales ──
    const totalCompras = compras.length;
    let totalItems = 0;
    let totalInvertido = 0;
    for (const c of compras) {
      totalItems += c.items.length;
      for (const it of c.items) {
        totalInvertido += toNumber(it.costoLote);
      }
    }
    const ticketPromedio = totalInvertido / totalCompras;

    // ── Ventas (opcional) ──
    let ventasSection = '';
    if (ventas.length > 0) {
      let ingresos = 0;
      let gananciaRealizada = 0;
      for (const v of ventas) {
        ingresos += v.cantidad * toNumber(v.precioVenta);
        gananciaRealizada += toNumber(v.gananciaTotal);
      }

      // Calcular stock restante por producto (inline, desde datos ya cargados)
      const stockMap = new Map<string, {
        stock: number;
        totalCost: number;
        latestPrecioVenta: number;
        latestUpdatedAt: Date;
      }>();

      for (const c of compras) {
        for (const it of c.items) {
          const current = stockMap.get(it.nombre);
          const costLote = toNumber(it.costoLote);
          const precioVenta = toNumber(it.precioVenta);
          if (current === undefined) {
            stockMap.set(it.nombre, {
              stock: it.cantidadLote,
              totalCost: costLote,
              latestPrecioVenta: precioVenta,
              latestUpdatedAt: it.updatedAt,
            });
          } else {
            current.stock += it.cantidadLote;
            current.totalCost += costLote;
            if (it.updatedAt > current.latestUpdatedAt) {
              current.latestPrecioVenta = precioVenta;
              current.latestUpdatedAt = it.updatedAt;
            }
          }
        }
      }

      for (const v of ventas) {
        const current = stockMap.get(v.productoNombre);
        if (current) {
          current.stock -= v.cantidad;
        }
      }

      let gananciaPotencialRestante = 0;
      let totalRemainingStock = 0;
      let totalRemainingCost = 0;

      for (const [nombre, info] of stockMap) {
        if (info.stock > 0) {
          const soldQty = ventas
            .filter((v) => v.productoNombre === nombre)
            .reduce((sum, v) => sum + v.cantidad, 0);
          const originalTotal = info.stock + soldQty;
          const unitCost = originalTotal > 0 ? info.totalCost / originalTotal : 0;
          const stockCost = unitCost * info.stock;

          totalRemainingStock += info.stock;
          totalRemainingCost += stockCost;
          gananciaPotencialRestante += info.stock * info.latestPrecioVenta - stockCost;
        }
      }

      const costoPromedio = totalRemainingStock > 0
        ? totalRemainingCost / totalRemainingStock
        : 0;

      ventasSection =
        `\n\n▫️ *Ventas*\n` +
        `   💰 Ingresos: $${fmtArs(ingresos)}\n` +
        `   ✅ Ganancia realizada: $${fmtArs(gananciaRealizada)}\n` +
        `   📊 Ganancia potencial restante: $${fmtArs(gananciaPotencialRestante)}\n` +
        `   💵 Costo promedio: $${fmtArs(costoPromedio)}`;
    }

    // ── Por grupo (opcional) ──
    let grupoSection = '';
    const grupos = await deps.prisma.grupoProducto.findMany() as GrupoProducto[];
    if (grupos.length > 0) {
      const userProductNames = new Set<string>();
      for (const c of compras) {
        for (const it of c.items) {
          userProductNames.add(it.nombre);
        }
      }
      const gruposConProductos = grupos.filter((g) => userProductNames.has(g.productoNombre));
      if (gruposConProductos.length > 0) {
        const groupCount = new Map<string, { count: number; totalInvertido: number }>();
        for (const g of gruposConProductos) {
          const current = groupCount.get(g.grupoNombre) ?? { count: 0, totalInvertido: 0 };
          current.count++;
          // Find the invest amount for this product
          for (const c of compras) {
            for (const it of c.items) {
              if (it.nombre === g.productoNombre) {
                current.totalInvertido += toNumber(it.costoLote);
              }
            }
          }
          groupCount.set(g.grupoNombre, current);
        }
        const groupLines = Array.from(groupCount.entries())
          .sort((a, b) => b[1].totalInvertido - a[1].totalInvertido)
          .map(([grupo, info]) => `   📁 ${grupo}: $${fmtArs(info.totalInvertido)} invertido · ${info.count} ${plural(info.count, 'producto', 'productos')}`);
        grupoSection = `\n\n▫️ *Por grupo*\n${groupLines.join('\n')}`;
      }
    }

    return (
      `📊 *ESTADÍSTICAS*\n` +
      `\n▫️ *Este mes*\n` +
      `   📦 ${monthCompras.length} ${plural(monthCompras.length, 'compra', 'compras')}\n` +
      `   💸 Invertido: $${fmtArs(mesInvertido)}\n` +
      `   📈 Ganancia potencial: $${fmtArs(mesGanancia)}\n` +
      `\n▫️ *Totales*\n` +
      `   🛒 ${totalCompras} ${plural(totalCompras, 'compra', 'compras')} · ${totalItems} ${plural(totalItems, 'item', 'items')}\n` +
      `   🎫 Ticket promedio: $${fmtArs(ticketPromedio)}` +
      ventasSection +
      grupoSection
    );
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'estadisticas', err: (err as Error).message },
      'getEstadisticas failed',
    );
    return 'Tuve un error consultando estadísticas. Probá de nuevo en un ratito.';
  }
}

// ── 2. productos ─────────────────────────────────────────────────────

export type StockPerProductInfo = {
  stock: number;
  latestPrecioVenta: number;
  totalCost: number;
};

/**
 * Mapa de producto → stock restante, precio de venta más reciente, y
 * costo proporcional del stock restante. Usado internamente por
 * getProductos.
 */
async function getStockPerProduct(
  usuarioId: string,
  deps: QueryDeps,
): Promise<Map<string, StockPerProductInfo>> {
  const result = new Map<string, StockPerProductInfo>();

  try {
    const compras = (await deps.prisma.compra.findMany({
      where: { usuarioId },
      include: { items: true },
    })) as Array<{
      items: Array<{
        nombre: string;
        cantidadLote: number;
        costoLote: unknown;
        precioVenta: unknown;
        updatedAt: Date;
      }>;
    }>;

    const ventas = (await deps.prisma.venta.findMany({
      where: { usuarioId },
    })) as Array<{ productoNombre: string; cantidad: number }>;

    if (compras.length === 0) return result;

    const stockMap = new Map<string, {
      totalStock: number;
      totalCost: number;
      latestPrecioVenta: number;
      latestUpdatedAt: Date;
    }>();

    for (const c of compras) {
      for (const it of c.items) {
        const current = stockMap.get(it.nombre);
        const costLote = toNumber(it.costoLote);
        const precioVenta = toNumber(it.precioVenta);
        if (current === undefined) {
          stockMap.set(it.nombre, {
            totalStock: it.cantidadLote,
            totalCost: costLote,
            latestPrecioVenta: precioVenta,
            latestUpdatedAt: it.updatedAt,
          });
        } else {
          current.totalStock += it.cantidadLote;
          current.totalCost += costLote;
          if (it.updatedAt > current.latestUpdatedAt) {
            current.latestPrecioVenta = precioVenta;
            current.latestUpdatedAt = it.updatedAt;
          }
        }
      }
    }

    for (const v of ventas) {
      const current = stockMap.get(v.productoNombre);
      if (current) {
        current.totalStock -= v.cantidad;
      }
    }

    for (const [nombre, info] of stockMap) {
      if (info.totalStock > 0) {
        const soldQty = ventas
          .filter((v) => v.productoNombre === nombre)
          .reduce((a, v) => a + v.cantidad, 0);
        const originalTotal = info.totalStock + soldQty;
        const unitCost = originalTotal > 0 ? info.totalCost / originalTotal : 0;
        result.set(nombre, {
          stock: info.totalStock,
          latestPrecioVenta: info.latestPrecioVenta,
          totalCost: unitCost * info.totalStock,
        });
      }
    }

    return result;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'stock-per-product', err: (err as Error).message },
      'getStockPerProduct failed',
    );
    return result;
  }
}

/**
 * Lista de productos con stock disponible.
 * Reemplaza los viejos getProductos + getStock.
 */
export async function getProductos(
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const stockMap = await getStockPerProduct(usuarioId, deps);

    if (stockMap.size === 0) return EMPTY_DB_MESSAGE;

    // Try to group by grupoProducto
    const grupos = await deps.prisma.grupoProducto.findMany() as GrupoProducto[];
    if (grupos.length > 0) {
      const grouped = new Map<string, Array<{ name: string; stock: number }>>();
      const ungrouped: Array<{ name: string; stock: number }> = [];

      for (const [name, info] of stockMap) {
        const g = grupos.find((gp) => gp.productoNombre === name);
        if (g) {
          const arr = grouped.get(g.grupoNombre) ?? [];
          arr.push({ name, stock: info.stock });
          grouped.set(g.grupoNombre, arr);
        } else {
          ungrouped.push({ name, stock: info.stock });
        }
      }

      const lines: string[] = [];
      for (const [grupo, products] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`📁 *${grupo}*`);
        for (const p of products) {
          lines.push(`• ${p.name} — ${p.stock} en stock`);
        }
        lines.push('');
      }
      if (ungrouped.length > 0) {
        lines.push(`📦 *SIN GRUPO*`);
        for (const p of ungrouped.sort((a, b) => a.name.localeCompare(b.name))) {
          lines.push(`• ${p.name} — ${p.stock} en stock`);
        }
        lines.push('');
      }
      // Remove trailing empty line
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

      return `📦 *PRODUCTOS*\n\n${lines.join('\n')}`;
    }

    // No groups — flat list (backward compat)
    const lines = Array.from(stockMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, info]) => `• ${name} — ${info.stock} en stock`);

    return `📦 *PRODUCTOS*\n\n${lines.join('\n')}`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'productos', err: (err as Error).message },
      'getProductos failed',
    );
    return 'Tuve un error listando productos. Probá de nuevo en un ratito.';
  }
}

// ── 3. producto <nombre> ─────────────────────────────────────────────

/** Detalle de un producto con fuzzy match. Mismo comportamiento, nuevo formato visual. */
export async function getProductoByName(
  usuarioId: string,
  query: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return 'Decime el nombre del producto. Ej: "producto medias negras".';

    const exact = (await deps.prisma.itemCompra.findMany({
      where: { compra: { usuarioId }, nombre: { equals: q } },
      orderBy: { updatedAt: 'desc' },
      take: 1,
    })) as ItemCompra[];

    if (exact.length > 0) {
      return formatProductoDetalle(exact[0]!);
    }

    const fuzzy = (await deps.prisma.$queryRaw`
      SELECT i.*
      FROM "ItemCompra" i
      INNER JOIN "Compra" c ON c.id = i."compraId"
      WHERE c."usuarioId" = ${usuarioId}
        AND similarity(i.nombre, ${q}) > 0.4
      ORDER BY similarity(i.nombre, ${q}) DESC, i."updatedAt" DESC
      LIMIT 1
    `) as ItemCompra[];

    if (fuzzy.length === 0) {
      return `No encontré "${query}" en tus compras. ¿Está bien escrito?`;
    }
    return formatProductoDetalle(fuzzy[0]!);
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'producto', err: (err as Error).message },
      'getProductoByName failed',
    );
    return 'Tuve un error buscando ese producto. Probá de nuevo en un ratito.';
  }
}

function formatProductoDetalle(item: ItemCompra): string {
  const cant = item.cantidadLote;
  const unidad = item.unidad.toLowerCase();
  const costoU = fmtArs(item.costoUnitario);
  const venta = fmtArs(item.precioVenta);
  const gananciaU = fmtArs(item.gananciaUnitaria);
  return (
    `🔍 *${item.nombre}*\n` +
    `   Stock: ${cant} ${unidad}\n` +
    `   Costo: $${costoU} c/u\n` +
    `   Venta: $${venta} c/u\n` +
    `   Ganancia: $${gananciaU} c/u`
  );
}

// ── 4. compras ───────────────────────────────────────────────────────

/** Listado de compras del mes con formato visual. */
export async function getComprasMes(
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const { from, to } = currentMonthRange();
    const compras = (await deps.prisma.compra.findMany({
      where: { usuarioId, fecha: { gte: from, lte: to } },
      orderBy: { fecha: 'desc' },
      include: { items: true },
    })) as Array<{ id: string; fecha: Date; items: Array<{ costoLote: unknown }> }>;

    if (compras.length === 0) return 'No tenés compras cargadas este mes.';

    const lines = compras.map((c) => {
      const fecha = c.fecha.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
      const total = c.items.reduce((a, it) => a + toNumber(it.costoLote), 0);
      return `• ${fecha} — $${fmtArs(total)}`;
    });
    return `🛒 *COMPRAS DEL MES* (${compras.length})\n\n${lines.join('\n')}`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'compras', err: (err as Error).message },
      'getComprasMes failed',
    );
    return 'Tuve un error listando las compras del mes. Probá de nuevo en un ratito.';
  }
}

// ── 5. top ───────────────────────────────────────────────────────────

/** Top N productos por gananciaUnitaria (cross-usuario). */
export async function getTopGanancias(
  limit: number,
  deps: QueryDeps,
): Promise<string> {
  try {
    const items = (await deps.prisma.itemCompra.findMany({
      where: {},
      orderBy: { gananciaUnitaria: 'desc' },
      take: limit,
    })) as ItemCompra[];

    if (items.length === 0) return EMPTY_DB_MESSAGE;

    const lines = items.map(
      (it, i) => `${i + 1}. ${it.nombre} — $${fmtArs(it.gananciaUnitaria)} c/u`,
    );
    return `🏆 *TOP GANANCIAS*\n\n${lines.join('\n')}`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'top', err: (err as Error).message },
      'getTopGanancias failed',
    );
    return 'Tuve un error buscando el top. Probá de nuevo en un ratito.';
  }
}

// ── 6. grupo <nombre> ────────────────────────────────────────────────

/**
 * Stats for a single group: list products, calculate total stock/investment.
 */
export async function getGrupoStats(
  usuarioId: string,
  nombre: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const grupos = await deps.prisma.grupoProducto.findMany({
      where: { grupoNombre: { equals: nombre } },
    }) as GrupoProducto[];

    if (grupos.length === 0) {
      return `No encontré el grupo "${nombre}".`;
    }

    const stockMap = await getStockPerProduct(usuarioId, deps);
    const groupProducts = grupos.filter((g) => stockMap.has(g.productoNombre));

    if (groupProducts.length === 0) {
      return `El grupo "${nombre}" existe pero no tenés productos de ese grupo.`;
    }

    // Calculate original total purchased per product
    const compras = (await deps.prisma.compra.findMany({
      where: { usuarioId },
      select: { items: { select: { nombre: true, cantidadLote: true } } },
    })) as Array<{ items: Array<{ nombre: string; cantidadLote: number }> }>;

    const ventas = (await deps.prisma.venta.findMany({
      where: { usuarioId },
      select: { productoNombre: true, cantidad: true },
    })) as Array<{ productoNombre: string; cantidad: number }>;

    const originalMap = new Map<string, number>();
    for (const c of compras) {
      for (const it of c.items) {
        originalMap.set(it.nombre, (originalMap.get(it.nombre) ?? 0) + it.cantidadLote);
      }
    }
    for (const v of ventas) {
      const prev = originalMap.get(v.productoNombre);
      if (prev !== undefined) {
        // original stays as purchased; remaining = original - sold
      }
    }

    const lines: string[] = [];
    let totalInvertido = 0;
    let totalStock = 0;
    let totalOriginal = 0;
    let gananciaPotencial = 0;

    for (const g of groupProducts) {
      const info = stockMap.get(g.productoNombre)!;
      const original = originalMap.get(g.productoNombre) ?? info.stock;
      totalInvertido += info.totalCost;
      totalStock += info.stock;
      totalOriginal += original;
      const ventaPotential = info.stock * info.latestPrecioVenta;
      gananciaPotencial += ventaPotential - info.totalCost;
      lines.push(
        `• ${g.productoNombre} — ${info.stock}/${original} u. · $${fmtArs(info.totalCost)}`,
      );
    }

    const gananciaActual = gananciaPotencial;

    return (
      `📁 *GRUPO: ${nombre}*\n` +
      `   📦 ${groupProducts.length} producto${groupProducts.length !== 1 ? 's' : ''} · ${totalStock}/${totalOriginal} unidades\n\n` +
      lines.join('\n') +
      `\n\n📊 *Resumen*\n` +
      `   💸 Invertido: $${fmtArs(totalInvertido)}\n` +
      `   📈 Ganancia potencial: $${fmtArs(gananciaPotencial)}\n` +
      `   ✅ Ganancia actual: $${fmtArs(gananciaActual)}`
    );
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'grupo', err: (err as Error).message },
      'getGrupoStats failed',
    );
    return 'Tuve un error consultando el grupo. Probá de nuevo en un ratito.';
  }
}

// ── Command dispatcher ───────────────────────────────────────────────

/** Ejecuta un query command y devuelve el string formateado. */
export async function executeQuery(
  cmd: QueryCommand,
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  switch (cmd.type) {
    case 'estadisticas':
      return getEstadisticas(usuarioId, deps);
    case 'productos':
      return getProductos(usuarioId, deps);
    case 'producto':
      return getProductoByName(usuarioId, cmd.nombre, deps);
    case 'compras':
      return getComprasMes(usuarioId, deps);
    case 'top':
      return getTopGanancias(5, deps);
    case 'grupo':
      return getGrupoStats(usuarioId, cmd.nombre, deps);
  }
}

// ── Helpers exportados / constantes ──────────────────────────────────

/** Texto completo para /ayuda — lista solo los 5 comandos de consulta. */
export const HELP_TEXT = `Comandos disponibles:

/nueva — Cargar una compra nueva.
/agregar — Agregar stock a un producto.
/vender — Vender un producto.
/editar — Editar un producto.
/eliminar — Eliminar productos.
/grupo <producto> — Asignar un producto a un grupo.
/exportar — Descargar Excel con todos los datos.
/importar — Importar datos desde un archivo Excel.
/ayuda — Mostrar esta ayuda.

Consultas:
• estadisticas — Todas las estadísticas en un solo lugar.
• productos — Lista de productos con stock (agrupados por grupo).
• producto <nombre> — Detalle de un producto.
• compras — Compras de este mes.
• top — Top productos por ganancia.
• grupo — Estadísticas de un grupo de productos (seleccioná de la lista).

En cualquier momento:
• cancelar — Cancelar el flujo actual.
• menu — Volver al inicio.`;

/** Mensaje de ayuda cuando el usuario tipea un comando desconocido. */
export const UNKNOWN_COMMAND_MESSAGE =
  'No entendí. Comandos: /nueva, /agregar, /editar, /eliminar, /grupo <producto>, /exportar, /importar, /ayuda, ' +
  'estadisticas, productos, producto <nombre>, compras, top, grupo.';

/** Log cuando un comando desconocido llega (OWASP A09). */
export function logUnknownCommand(logger: AnyLogger, raw: string): void {
  logSecurityEvent(logger, 'state_transition_invalid', {
    context: 'unknown_command',
    raw,
  });
}
