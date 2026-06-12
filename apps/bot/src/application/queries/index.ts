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
  | { type: 'top-ganancias' };

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
  }
}

/** Texto completo para /ayuda — lista todos los comandos disponibles. */
export const HELP_TEXT = `Comandos disponibles:

/nueva — Cargar una compra nueva. Te voy a hacer paso a paso las preguntas.
/agregar — Agregar stock a un producto que ya cargaste.
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

En cualquier momento:
• cancelar — Cancelar el flujo actual.
• menu — Volver al inicio.`;

/** Mensaje de ayuda cuando el usuario tipea un comando desconocido. */
export const UNKNOWN_COMMAND_MESSAGE =
  'No entendí. Comandos: /nueva, /agregar, /ayuda, resumen, estadisticas, ganancias, productos, ' +
  'stock, producto <nombre>, compras mes, top ganancias.';

/** Log cuando un comando desconocido llega (OWASP A09). */
export function logUnknownCommand(logger: AnyLogger, raw: string): void {
  logSecurityEvent(logger, 'state_transition_invalid', {
    context: 'unknown_command',
    raw,
  });
}
