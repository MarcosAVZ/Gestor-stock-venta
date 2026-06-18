/**
 * @compras-whatsapp/bot — Vender (use case).
 *
 * RESPONSABILIDAD:
 * Manejar el flujo /vender — listar productos con stock, calcular stock
 * disponible, calcular costo promedio ponderado, y guardar ventas.
 *
 * FLUJO:
 * 1. listarProductosConStock: consulta items y ventas, retorna productos
 *    con stock > 0.
 * 2. calcularStock: SUM(cantidadLote) - SUM(cantidad) from Ventas.
 * 3. calcularCostoPromedio: weighted average = SUM(costoLote) / SUM(cantidadLote).
 *
 * POR QUÉ ESTE USE CASE:
 * - Separado de SaveVenta porque el flujo es distinto: acá calculamos
 *   stock y costo promedio antes de guardar.
 * - Testeable con mocks de repos (sin DB).
 * - Sigue el patrón de AgregarStock: dependencias inyectadas vía deps.
 *
 * DECISIONES:
 * - El costo promedio es ponderado por cantidad de cada lote.
 * - Si no hay items, retorna 0 (no falla).
 * - Las ventas se filtran por usuarioId y productoNombre.
 */
import type { PrismaClientLike } from '../../infrastructure/persistence/PrismaClientLike.ts';
import type { VentaRepository } from '../../domain/repositories/VentaRepository.ts';

// ── Types ─────────────────────────────────────────────────────────────

export interface ProductoConStock {
  indice: number;
  nombre: string;
  stock: number;
}

export interface VenderDeps {
  prisma: PrismaClientLike;
  ventaRepo: VentaRepository;
}

// ── listarProductosConStock ───────────────────────────────────────────

/**
 * Queries products with stock > 0.
 * Stock = SUM(cantidadLote) - SUM(cantidad from Ventas).
 *
 * La query agrupa items por nombre, luego filtra los que tienen stock > 0.
 */
export async function listarProductosConStock(
  usuarioId: string,
  deps: VenderDeps,
): Promise<ProductoConStock[]> {
  // 1. Get total quantity per product
  const items = await deps.prisma.itemCompra.groupBy({
    by: ['nombre'],
    where: { compra: { usuarioId } },
    _sum: { cantidadLote: true },
  }) as Array<{ nombre: string; _sum: { cantidadLote: number | null } }>;

  // 2. Calculate stock for each product
  const productos: ProductoConStock[] = [];
  let idx = 1;
  for (const item of items) {
    const totalComprado = item._sum.cantidadLote ?? 0;
    if (totalComprado <= 0) continue;

    // Get sold quantity for this product
    const ventas = await deps.ventaRepo.findByProductoNombre(usuarioId, item.nombre);
    const totalVendido = ventas.reduce((sum, v) => sum + v.cantidad, 0);
    const stock = totalComprado - totalVendido;

    if (stock > 0) {
      productos.push({
        indice: idx++,
        nombre: item.nombre,
        stock,
      });
    }
  }

  return productos;
}

// ── calcularStock ──────────────────────────────────────────────────────

/**
 * Calculates available stock for a specific product.
 * Stock = SUM(cantidadLote) - SUM(cantidad) from Ventas.
 *
 * @returns stock disponible (>= 0)
 */
export async function calcularStock(
  usuarioId: string,
  nombre: string,
  deps: VenderDeps,
): Promise<number> {
  // Get total quantity purchased
  const result = await deps.prisma.itemCompra.aggregate({
    where: { compra: { usuarioId }, nombre },
    _sum: { cantidadLote: true },
  }) as { _sum: { cantidadLote: number | null } };

  const totalComprado = result._sum.cantidadLote ?? 0;

  // Get total quantity sold
  const ventas = await deps.ventaRepo.findByProductoNombre(usuarioId, nombre);
  const totalVendido = ventas.reduce((sum, v) => sum + v.cantidad, 0);

  return Math.max(0, totalComprado - totalVendido);
}

// ── calcularCostoPromedio ──────────────────────────────────────────────

/**
 * Calculates weighted average cost across all lots for a product.
 * costoPromedio = SUM(costoLote) / SUM(cantidadLote).
 *
 * Example:
 * - Lot 1: 100 units, costoLote $500
 * - Lot 2: 50 units, costoLote $300
 * - Weighted average: $800 / 150 = $5.3333
 *
 * @returns weighted average cost (0 if no items)
 */
export async function calcularCostoPromedio(
  usuarioId: string,
  nombre: string,
  deps: VenderDeps,
): Promise<number> {
  const items = await deps.prisma.itemCompra.findMany({
    where: { compra: { usuarioId }, nombre },
    select: { costoLote: true, cantidadLote: true },
  }) as Array<{ costoLote: unknown; cantidadLote: number }>;

  if (items.length === 0) return 0;

  let totalCosto = 0;
  let totalCantidad = 0;

  for (const item of items) {
    totalCosto += toNumber(item.costoLote);
    totalCantidad += item.cantidadLote;
  }

  if (totalCantidad === 0) return 0;

  return totalCosto / totalCantidad;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Extrae number de un Decimal de Prisma, number, o string. */
function toNumber(d: unknown): number {
  if (typeof d === 'number') return d;
  if (typeof d === 'string') return Number(d);
  if (d !== null && typeof d === 'object' && 'toNumber' in d && typeof (d as { toNumber: () => number }).toNumber === 'function') {
    return (d as { toNumber: () => number }).toNumber();
  }
  return 0;
}
