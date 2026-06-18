/**
 * @compras-whatsapp/bot — 8 query use cases (PR5 task 5.6).
 *
 * Cubre los 8 comandos de consulta definidos en
 * req-query-commands (spec obs#27):
 *   1. resumen            → resumen del mes actual
 *   2. estadisticas       → totales históricos
 *   3. ganancias          → suma de ganancias potenciales
 *   4. productos          → productos únicos cargados
 *   5. stock              → productos únicos con stock total
 *   6. producto <nombre>  → detalle con fuzzy match
 *   7. compras mes        → listado de compras del mes
 *   8. top ganancias      → top N items por gananciaUnitaria
 *
 * Cada use case:
 * - Recibe un `PrismaClientLike` para hacer queries directas de
 *   agregación (SUM, COUNT, GROUP BY). No usa el `CompraRepository`
 *   porque la interfaz solo expone findBy*; las agregaciones son
 *   específicas de cada query.
 * - Retorna un string voseo es-AR listo para enviar por WhatsApp.
 * - Si la DB está vacía, retorna un mensaje de "todavía no cargaste
 *   compras" (no falla, no throw).
 * - Si la query falla, retorna string con error genérico + loguea el
 *   error (no throw — el dispatcher sigue vivo).
 *
 * POR QUÉ UN SOLO ARCHIVO:
 * - Los 8 use cases son cortos (10-30 líneas c/u) y comparten el
 *   mismo PrismaClientLike + formateo. Tener 8 archivos separados
 *   con su propio index.ts sería ceremony sin valor.
 * - El tests file agrupa todos los tests con mocks compartidos.
 * - Si crece la cantidad de queries, se separan por dominio (ej:
 *   queries/products.ts, queries/stats.ts, queries/singleProduct.ts).
 *
 * OWASP:
 * - Ninguna query expone datos de otros usuarios (todas filtran
 *   por `usuarioId` del input, salvo `top ganancias` que es
 *   cross-usuario por diseño).
 * - Inputs no se persisten (son read-only).
 */
import type { ItemCompra } from '@compras-whatsapp/db';
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

/** Helper para extraer un numero de un Decimal de Prisma (que puede
 *  venir como Decimal, number o string según el delegate). */
function toNumber(d: unknown): number {
  if (typeof d === 'number') return d;
  if (typeof d === 'string') return Number(d);
  if (d !== null && typeof d === 'object' && 'toNumber' in d && typeof (d as { toNumber: () => number }).toNumber === 'function') {
    return (d as { toNumber: () => number }).toNumber();
  }
  return 0;
}

/** Rango de fechas del mes actual en timezone local (cero overhead). */
function currentMonthRange(now: Date = new Date()): { from: Date; to: Date } {
  const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return { from, to };
}

// ── Tipos de input compartidos ───────────────────────────────────────

export interface QueryDeps {
  prisma: PrismaClientLike;
  logger: AnyLogger;
}

// ── 1. resumen ───────────────────────────────────────────────────────

/** "Este mes: N compras, invertido $X, ganancia potencial $Y." */
export async function getResumen(
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const { from, to } = currentMonthRange();
    const compras = (await deps.prisma.compra.findMany({
      where: { usuarioId, fecha: { gte: from, lte: to } },
      include: { items: true },
    })) as Array<{ id: string; items: Array<{ costoLote: unknown; gananciaTotal: unknown }> }>;

    if (compras.length === 0) return EMPTY_DB_MESSAGE;

    let invertido = 0;
    let ganancia = 0;
    for (const c of compras) {
      for (const it of c.items) {
        invertido += toNumber(it.costoLote);
        ganancia += toNumber(it.gananciaTotal);
      }
    }
    return `Este mes: ${compras.length} compras, invertido $${fmtArs(invertido)}, ganancia potencial $${fmtArs(ganancia)}.`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'resumen', err: (err as Error).message },
      'getResumen failed',
    );
    return 'Tuve un error consultando el resumen. Probá de nuevo en un ratito.';
  }
}

// ── 2. estadisticas ──────────────────────────────────────────────────

/** "Total: N compras, M items, ticket promedio $X." */
export async function getEstadisticas(
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const compras = (await deps.prisma.compra.findMany({
      where: { usuarioId },
      include: { items: true },
    })) as Array<{ id: string; items: Array<{ costoLote: unknown }> }>;

    if (compras.length === 0) return EMPTY_DB_MESSAGE;

    const totalItems = compras.reduce((acc, c) => acc + c.items.length, 0);
    const totalInvertido = compras.reduce(
      (acc, c) => acc + c.items.reduce((a, it) => a + toNumber(it.costoLote), 0),
      0,
    );
    const ticketPromedio = compras.length > 0 ? totalInvertido / compras.length : 0;
    return `Total: ${compras.length} compras, ${totalItems} items, ticket promedio $${fmtArs(ticketPromedio)}.`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'estadisticas', err: (err as Error).message },
      'getEstadisticas failed',
    );
    return 'Tuve un error consultando estadísticas. Probá de nuevo en un ratito.';
  }
}

// ── 3. ganancias ─────────────────────────────────────────────────────

/** "Ganancia potencial acumulada: $X." */
export async function getGanancias(
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const compras = (await deps.prisma.compra.findMany({
      where: { usuarioId },
      include: { items: true },
    })) as Array<{ items: Array<{ gananciaTotal: unknown }> }>;

    if (compras.length === 0) return EMPTY_DB_MESSAGE;

    const total = compras.reduce(
      (acc, c) => acc + c.items.reduce((a, it) => a + toNumber(it.gananciaTotal), 0),
      0,
    );
    return `Ganancia potencial acumulada: $${fmtArs(total)}.`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'ganancias', err: (err as Error).message },
      'getGanancias failed',
    );
    return 'Tuve un error consultando ganancias. Probá de nuevo en un ratito.';
  }
}

// ── 4. productos ─────────────────────────────────────────────────────

/** Lista de productos únicos con cantidad de cargas cada uno. */
export async function getProductos(
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const items = (await deps.prisma.itemCompra.findMany({
      where: { compra: { usuarioId } },
      select: { nombre: true },
    })) as Array<{ nombre: string }>;

    if (items.length === 0) return EMPTY_DB_MESSAGE;

    const counts = new Map<string, number>();
    for (const it of items) {
      counts.set(it.nombre, (counts.get(it.nombre) ?? 0) + 1);
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    const lines = sorted.map(([name, count]) => `• ${name} (${count} carga${count > 1 ? 's' : ''})`);
    return `Tus ${sorted.length} productos:\n${lines.join('\n')}`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'productos', err: (err as Error).message },
      'getProductos failed',
    );
    return 'Tuve un error listando productos. Probá de nuevo en un ratito.';
  }
}

// ── 5. stock ─────────────────────────────────────────────────────────

/** Productos únicos con SUM(cantidadLote) agrupado por nombre. */
export async function getStock(
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const compras = (await deps.prisma.compra.findMany({
      where: { usuarioId },
      include: { items: true },
    })) as Array<{ items: Array<{ nombre: string; cantidadLote: number; unidad: string }> }>;

    if (compras.length === 0) return EMPTY_DB_MESSAGE;

    const stock = new Map<string, { cantidad: number; unidad: string }>();
    for (const c of compras) {
      for (const it of c.items) {
        const current = stock.get(it.nombre);
        if (current === undefined) {
          stock.set(it.nombre, { cantidad: it.cantidadLote, unidad: it.unidad });
        } else {
          current.cantidad += it.cantidadLote;
        }
      }
    }
    const lines = Array.from(stock.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, info]) => `• ${name}: ${info.cantidad} ${info.unidad.toLowerCase()}`);
    return `Tu stock:\n${lines.join('\n')}`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'stock', err: (err as Error).message },
      'getStock failed',
    );
    return 'Tuve un error consultando el stock. Probá de nuevo en un ratito.';
  }
}

// ── 6. producto <nombre> ─────────────────────────────────────────────

/** Detalle de un producto con fuzzy match. Si no hay match, mensaje. */
export async function getProductoByName(
  usuarioId: string,
  query: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return 'Decime el nombre del producto. Ej: "producto medias negras".';

    // Búsqueda exacta (lowercase match) primero — es más rápida y
    // más precisa. Si no hay match exacto, fuzzy con `pg_trgm` via
    // `$queryRaw` (el delegate `itemCompra` no expone similarity() en
    // el cliente generado sin raw SQL).
    const exact = (await deps.prisma.itemCompra.findMany({
      where: { compra: { usuarioId }, nombre: { equals: q } },
      orderBy: { updatedAt: 'desc' },
      take: 1,
    })) as ItemCompra[];

    if (exact.length > 0) {
      return formatProductoDetalle(exact[0]!);
    }

    // Fuzzy fallback: similarity > 0.4 con `pg_trgm`.
    // Usamos $queryRawUnsafe porque el cliente generado no tipa
    // la extension pg_trgm directamente. El nombre va como param
    // (no concatenado) — defense in depth contra SQL injection
    // aunque ya filtraremos por usuario en el resultado.
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
  return `${item.nombre}: ${cant} ${unidad}, costo $${costoU} c/u, vendés a $${venta}, ganancia $${gananciaU} c/u.`;
}

// ── 7. compras mes ───────────────────────────────────────────────────

/** Listado de compras del mes con fecha, proveedor, total. */
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
    return `Compras de este mes (${compras.length}):\n${lines.join('\n')}`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'compras-mes', err: (err as Error).message },
      'getComprasMes failed',
    );
    return 'Tuve un error listando las compras del mes. Probá de nuevo en un ratito.';
  }
}

// ── 8. top ganancias ─────────────────────────────────────────────────

/** Top N items por gananciaUnitaria (cross-usuario). */
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
    return `Top ${items.length} ganancias unitarias:\n${lines.join('\n')}`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'top-ganancias', err: (err as Error).message },
      'getTopGanancias failed',
    );
    return 'Tuve un error buscando el top. Probá de nuevo en un ratito.';
  }
}

// ── 9. ingresos ──────────────────────────────────────────────────────

/** "Ingresos generados: $X." — suma de cantidad × precioVenta de Ventas. */
export async function getIngresos(
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const ventas = (await deps.prisma.venta.findMany({
      where: { usuarioId },
    })) as Array<{ cantidad: number; precioVenta: unknown }>;

    if (ventas.length === 0) return 'Todavía no registaste ventas. Usá /vender para empezar.';

    const total = ventas.reduce(
      (acc, v) => acc + v.cantidad * toNumber(v.precioVenta),
      0,
    );
    return `Ingresos generados: $${fmtArs(total)}.`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'ingresos', err: (err as Error).message },
      'getIngresos failed',
    );
    return 'Tuve un error consultando ingresos. Probá de nuevo en un ratito.';
  }
}

// ── 10. ganancia realizada ───────────────────────────────────────────

/** "Ganancia realizada: $X." — suma de gananciaTotal de Ventas. */
export async function getGananciaRealizada(
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const ventas = (await deps.prisma.venta.findMany({
      where: { usuarioId },
    })) as Array<{ gananciaTotal: unknown }>;

    if (ventas.length === 0) return 'Todavía no registaste ventas. Usá /vender para empezar.';

    const total = ventas.reduce(
      (acc, v) => acc + toNumber(v.gananciaTotal),
      0,
    );
    return `Ganancia realizada: $${fmtArs(total)}.`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'ganancia-realizada', err: (err as Error).message },
      'getGananciaRealizada failed',
    );
    return 'Tuve un error consultando ganancia realizada. Probá de nuevo en un ratito.';
  }
}

// ── 11. stock per product (helper) ───────────────────────────────────

export type StockPerProductInfo = {
  stock: number;
  latestPrecioVenta: number;
  totalCost: number;
};

/**
 * Mapa de producto → stock restante, precio de venta más reciente, y
 * costo proporcional del stock restante. Usado por ganancia potencial
 * y costo promedio.
 */
export async function getStockPerProduct(
  usuarioId: string,
  deps: QueryDeps,
): Promise<Map<string, StockPerProductInfo>> {
  const result = new Map<string, StockPerProductInfo>();

  try {
    const compras = (await deps.prisma.compra.findMany({
      where: { usuarioId },
      include: { items: true },
    })) as Array<{ items: Array<{ nombre: string; cantidadLote: number; costoLote: unknown; precioVenta: unknown; updatedAt: Date }> }>;

    const ventas = (await deps.prisma.venta.findMany({
      where: { usuarioId },
    })) as Array<{ productoNombre: string; cantidad: number }>;

    if (compras.length === 0) return result;

    // Build stock per product from ItemCompra
    const stockMap = new Map<string, { totalStock: number; totalCost: number; latestPrecioVenta: number; latestUpdatedAt: Date }>();

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
          // Keep the most recent precioVenta
          if (it.updatedAt > current.latestUpdatedAt) {
            current.latestPrecioVenta = precioVenta;
            current.latestUpdatedAt = it.updatedAt;
          }
        }
      }
    }

    // Subtract sold quantities
    for (const v of ventas) {
      const current = stockMap.get(v.productoNombre);
      if (current) {
        current.totalStock -= v.cantidad;
      }
    }

    // Build result, excluding products with zero or negative stock
    for (const [nombre, info] of stockMap) {
      if (info.totalStock > 0) {
        const unitCost = info.totalCost / (info.totalStock + ventas.filter(v => v.productoNombre === nombre).reduce((a, v) => a + v.cantidad, 0));
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

// ── 12. ganancia potencial ───────────────────────────────────────────

/** "Ganancia potencial: $X." — ganancia de stock restante a precio de lista. */
export async function getGananciaPotencial(
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const stockMap = await getStockPerProduct(usuarioId, deps);

    if (stockMap.size === 0) {
      // Check if there are any compras at all
      const compras = (await deps.prisma.compra.findMany({
        where: { usuarioId },
      })) as Array<unknown>;
      if (compras.length === 0) return 'Todavía no cargaste compras. Usá /nueva para empezar.';
    }

    let total = 0;
    for (const [, info] of stockMap) {
      total += info.stock * info.latestPrecioVenta - info.totalCost;
    }
    return `Ganancia potencial: $${fmtArs(total)}.`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'ganancia-potencial', err: (err as Error).message },
      'getGananciaPotencial failed',
    );
    return 'Tuve un error consultando ganancia potencial. Probá de nuevo en un ratito.';
  }
}

// ── 13. costo promedio ───────────────────────────────────────────────

/** "Costo promedio: $X." — costo promedio ponderado del stock restante. */
export async function getCostoPromedio(
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  try {
    const stockMap = await getStockPerProduct(usuarioId, deps);

    if (stockMap.size === 0) {
      const compras = (await deps.prisma.compra.findMany({
        where: { usuarioId },
      })) as Array<unknown>;
      if (compras.length === 0) return 'Todavía no cargaste compras. Usá /nueva para empezar.';
    }

    let totalRemainingStock = 0;
    let totalRemainingCost = 0;
    for (const [, info] of stockMap) {
      totalRemainingStock += info.stock;
      totalRemainingCost += info.totalCost;
    }

    if (totalRemainingStock === 0) return 'Costo promedio: $0.';
    const costoPromedio = totalRemainingCost / totalRemainingStock;
    return `Costo promedio: $${fmtArs(costoPromedio)}.`;
  } catch (err) {
    deps.logger.error(
      { event: 'query_failed', query: 'costo-promedio', err: (err as Error).message },
      'getCostoPromedio failed',
    );
    return 'Tuve un error consultando costo promedio. Probá de nuevo en un ratito.';
  }
}

// ── Command dispatcher (single entrypoint para el wire-up) ───────────

/** Mapea un comando de texto a su use case. Retorna null si no matchea. */
export type QueryCommand =
  | { type: 'resumen' }
  | { type: 'estadisticas' }
  | { type: 'ganancias' }
  | { type: 'productos' }
  | { type: 'stock' }
  | { type: 'producto'; nombre: string }
  | { type: 'compras-mes' }
  | { type: 'top-ganancias' }
  | { type: 'ingresos' }
  | { type: 'ganancia-realizada' }
  | { type: 'ganancia-potencial' }
  | { type: 'costo-promedio' };

export function parseQueryCommand(input: string): QueryCommand | null {
  const text = input.trim().toLowerCase();
  if (text === 'resumen') return { type: 'resumen' };
  if (text === 'estadisticas' || text === 'estadísticas') return { type: 'estadisticas' };
  if (text === 'ganancias') return { type: 'ganancias' };
  if (text === 'productos') return { type: 'productos' };
  if (text === 'stock') return { type: 'stock' };
  if (text === 'compras mes' || text === 'compras-mes' || text === 'compras del mes') {
    return { type: 'compras-mes' };
  }
  if (text === 'top ganancias' || text === 'top') return { type: 'top-ganancias' };
  if (text === 'ingresos') return { type: 'ingresos' };
  if (text === 'ganancia realizada') return { type: 'ganancia-realizada' };
  if (text === 'ganancia potencial') return { type: 'ganancia-potencial' };
  if (text === 'costo promedio') return { type: 'costo-promedio' };
  if (text.startsWith('producto ')) {
    const nombre = text.slice('producto '.length).trim();
    if (nombre.length > 0) return { type: 'producto', nombre };
  }
  return null;
}

/** Ejecuta un query command y devuelve el string formateado. */
export async function executeQuery(
  cmd: QueryCommand,
  usuarioId: string,
  deps: QueryDeps,
): Promise<string> {
  switch (cmd.type) {
    case 'resumen':
      return getResumen(usuarioId, deps);
    case 'estadisticas':
      return getEstadisticas(usuarioId, deps);
    case 'ganancias':
      return getGanancias(usuarioId, deps);
    case 'productos':
      return getProductos(usuarioId, deps);
    case 'stock':
      return getStock(usuarioId, deps);
    case 'producto':
      return getProductoByName(usuarioId, cmd.nombre, deps);
    case 'compras-mes':
      return getComprasMes(usuarioId, deps);
    case 'top-ganancias':
      return getTopGanancias(5, deps);
    case 'ingresos':
      return getIngresos(usuarioId, deps);
    case 'ganancia-realizada':
      return getGananciaRealizada(usuarioId, deps);
    case 'ganancia-potencial':
      return getGananciaPotencial(usuarioId, deps);
    case 'costo-promedio':
      return getCostoPromedio(usuarioId, deps);
  }
}

/** Texto completo para /ayuda — lista todos los comandos disponibles. */
export const HELP_TEXT = `Comandos disponibles:

/nueva — Cargar una compra nueva. Te voy a hacer paso a paso las preguntas.
/agregar — Agregar stock a un producto que ya cargaste.
/vender — Vender un producto que ya cargaste.
/editar — Editar un producto existente (nombre, cantidad, unidad, costo o precio).
/eliminar — Eliminar todos los productos cargados.
/ayuda — Mostrar esta ayuda.

Consultas:
• resumen — Resumen del mes actual.
• estadisticas — Totales históricos.
• ganancias — Ganancia potencial acumulada.
• productos — Lista de productos cargados.
• stock — Productos con stock total.
• producto <nombre> — Detalle de un producto.
• compras mes — Listado de compras del mes.
• top ganancias — Top productos por ganancia.
• ingresos — Total de ingresos por ventas.
• ganancia realizada — Ganancia total de ventas concretadas.
• ganancia potencial — Ganancia estimada del stock restante.
• costo promedio — Costo promedio del stock actual.

En cualquier momento:
• cancelar — Cancelar el flujo actual.
• menu — Volver al inicio.`;

/** Mensaje de ayuda cuando el usuario tipea un comando desconocido. */
export const UNKNOWN_COMMAND_MESSAGE =
  'No entendí. Comandos: /nueva, /agregar, /editar, /eliminar, /ayuda, resumen, estadisticas, ganancias, productos, ' +
  'stock, producto <nombre>, compras mes, top ganancias, ingresos, ganancia realizada, ganancia potencial, costo promedio.';

/** Log cuando un comando desconocido llega (OWASP A09). */
export function logUnknownCommand(logger: AnyLogger, raw: string): void {
  logSecurityEvent(logger, 'state_transition_invalid', {
    context: 'unknown_command',
    raw,
  });
}
