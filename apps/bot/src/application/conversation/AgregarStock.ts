/**
 * @compras-whatsapp/bot — AgregarStock (use case).
 *
 * RESPONSABILIDAD:
 * Manejar el flujo /agregar — listar productos disponibles y agregar
 * stock a uno existente reutilizando su costo/precio histórico.
 *
 * FLUJO:
 * 1. listarProductos: consulta items existentes, deduplica por nombre
 *    (usa el más reciente por cada producto), retorna lista numerada.
 * 2. agregarStock: el usuario elige un índice, se valida, se calculan
 *    métricas con el costo/precio del producto original y la nueva
 *    cantidad, se crea Compra + ItemCompra.
 *
 * POR QUÉ ESTE USE CASE:
 * - Separado de SaveCompra porque el flujo es distinto: acá reutilizamos
 *   costo/precio de un producto existente, no pedimos datos nuevos.
 * - Testeable con mocks de repos (sin DB).
 * - Sigue el patrón de SaveCompra: dependencias inyectadas vía deps.
 *
 * DECISIONES:
 * - La dedup se hace en application layer (no en DB) porque la query
 *   ya trae los items ordenados por updatedAt DESC; el primero es el
 *   más reciente por nombre.
 * - Si el índice no existe, lanzamos Error (no InvariantViolationError)
 *   porque es un input del usuario, no un bug del caller.
 * - Si cantidad <= 0, lanzamos Error (input del usuario).
 */
import type { PrismaClientLike } from '../../infrastructure/persistence/PrismaClientLike.ts';
import type { CompraRepository } from '../../domain/repositories/CompraRepository.ts';
import type { ItemCompraRepository } from '../../domain/repositories/ItemCompraRepository.ts';
import { Decimal } from 'decimal.js';
import { calcularMetricas } from '../pricing/CalcularMetricas.ts';

// ── Types ─────────────────────────────────────────────────────────────

export interface ProductoDisponible {
  indice: number;
  nombre: string;
  costoLote: number;
  precioVenta: number;
  unidad: string;
}

export interface AgregarStockDeps {
  prisma: PrismaClientLike;
  compraRepo: CompraRepository;
  itemCompraRepo: ItemCompraRepository;
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

// ── listarProductos ───────────────────────────────────────────────────

/**
 * Queries distinct products available for stock addition.
 * Returns numbered list (1-based) with latest cost/price per product.
 *
 * La query trae todos los items del usuario ordenados por updatedAt DESC.
 * La dedup toma la primera aparición de cada nombre = el más reciente.
 */
export async function listarProductos(
  usuarioId: string,
  deps: { prisma: PrismaClientLike },
): Promise<ProductoDisponible[]> {
  const items = await deps.prisma.itemCompra.findMany({
    where: { compra: { usuarioId } },
    orderBy: { updatedAt: 'desc' },
    select: {
      nombre: true,
      costoLote: true,
      precioVenta: true,
      unidad: true,
    },
  }) as Array<{ nombre: string; costoLote: unknown; precioVenta: unknown; unidad: string }>;

  // Deduplicate by nombre — first occurrence is most recent (orderBy desc)
  const seen = new Set<string>();
  const unique: ProductoDisponible[] = [];
  let idx = 1;
  for (const item of items) {
    if (seen.has(item.nombre)) continue;
    seen.add(item.nombre);
    unique.push({
      indice: idx++,
      nombre: item.nombre,
      costoLote: toNumber(item.costoLote),
      precioVenta: toNumber(item.precioVenta),
      unidad: item.unidad,
    });
  }
  return unique;
}

// ── agregarStock ──────────────────────────────────────────────────────

/**
 * Adds stock to an existing product.
 * Creates a new Compra + ItemCompra reusing the original cost/price
 * and calculating metrics with the new quantity.
 *
 * @throws {Error} if productoIndice doesn't match any product
 * @throws {Error} if cantidadNueva <= 0
 */
export async function agregarStock(
  input: { usuarioId: string; productoIndice: number; cantidadNueva: number },
  deps: AgregarStockDeps,
): Promise<void> {
  const productos = await listarProductos(input.usuarioId, deps);
  const selected = productos.find((p) => p.indice === input.productoIndice);
  if (selected === undefined) {
    throw new Error(`No existe producto con índice ${input.productoIndice}`);
  }
  if (input.cantidadNueva <= 0) {
    throw new Error('La cantidad tiene que ser mayor a cero');
  }

  // Calculate metrics with reused cost/price and new quantity
  const m = calcularMetricas({
    costoLote: selected.costoLote,
    cantidadReal: input.cantidadNueva,
    precioVenta: selected.precioVenta,
  });

  // Create Compra + ItemCompra
  const compra = await deps.compraRepo.create({ usuarioId: input.usuarioId });
  await deps.itemCompraRepo.createMany([{
    compraId: compra.id,
    nombre: selected.nombre,
    cantidadLote: input.cantidadNueva,
    unidad: selected.unidad as any,
    costoLote: new Decimal(selected.costoLote).toFixed(2),
    costoUnitario: m.costoUnitario.toDecimalPlaces(4).toFixed(),
    precioVenta: new Decimal(selected.precioVenta).toFixed(2),
    gananciaUnitaria: m.gananciaUnitaria.toDecimalPlaces(4).toFixed(),
    gananciaTotal: m.gananciaTotalEstimada.toDecimalPlaces(2).toFixed(),
  }]);
}
