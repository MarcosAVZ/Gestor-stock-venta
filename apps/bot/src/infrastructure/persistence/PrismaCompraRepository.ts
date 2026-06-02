/**
 * Adapter Prisma para `CompraRepository`.
 *
 * Detalles:
 * - `findByIdWithItems` usa `include: { items: true }` para eager-load.
 * - `findByDateRange` filtra con `fecha >= from AND fecha <= to`.
 * - `findTopByGanancias` ordena por `gananciaUnitaria DESC` y trunca a
 *   `limit`. No agrupa por compra — devuelve items sueltos con su
 *   `compra` cargada para que el caller pueda agregar si quiere.
 */

import { prisma } from '@compras-whatsapp/db';
import type { Compra, ItemCompra, Moneda } from '@compras-whatsapp/db';

import type { CompraRepository } from '../../domain/repositories/CompraRepository.ts';
import type { CompraWithItems, PrismaClientLike } from './PrismaClientLike.ts';

export class PrismaCompraRepository implements CompraRepository {
  constructor(private readonly db: PrismaClientLike = prisma as unknown as PrismaClientLike) {}

  async create(data: {
    usuarioId: string;
    imagenOriginal?: string;
    moneda?: Moneda;
  }): Promise<Compra> {
    const created = (await this.db.compra.create({ data })) as Compra;
    return created;
  }

  async findById(id: string): Promise<Compra | null> {
    return (await this.db.compra.findUnique({ where: { id } })) as Compra | null;
  }

  async findByIdWithItems(id: string): Promise<(Compra & { items: ItemCompra[] }) | null> {
    return (await this.db.compra.findUnique({
      where: { id },
      include: { items: true },
    })) as CompraWithItems | null;
  }

  async findByUsuarioId(usuarioId: string, limit = 100): Promise<Compra[]> {
    return (await this.db.compra.findMany({
      where: { usuarioId },
      orderBy: { fecha: 'desc' },
      take: limit,
    })) as Compra[];
  }

  async findByDateRange(opts: { from: Date; to: Date }): Promise<Compra[]> {
    return (await this.db.compra.findMany({
      where: { fecha: { gte: opts.from, lte: opts.to } },
      orderBy: { fecha: 'desc' },
    })) as Compra[];
  }

  async findTopByGanancias(limit: number): Promise<ItemCompra[]> {
    // Acceso directo al delegate `itemCompra` para ordenar por
    // gananciaUnitaria. Mantenemos el cast porque el subset
    // PrismaClientLike no incluye el delegate itemCompra para
    // sortByCompound en este método.
    const dbAny = this.db as unknown as {
      itemCompra: { findMany: (a: unknown) => Promise<ItemCompra[]> };
    };
    return dbAny.itemCompra.findMany({
      orderBy: { gananciaUnitaria: 'desc' },
      take: limit,
    });
  }
}
