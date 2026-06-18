/**
 * Adapter Prisma para `ItemCompraRepository`.
 *
 * Decisión clave: `findRecentByNombre` usa `$queryRaw` con
 * `pg_trgm.similarity()` para fuzzy match. Esto es SEGURO contra SQL
 * injection porque:
 * - El query es un template literal de Prisma (`Prisma.sql`).
 * - El parámetro se pasa como `$1` y Prisma lo escapa correctamente
 *   antes de mandar a Postgres.
 *
 * ⚠️ NO usar `$queryRawUnsafe` con input del usuario — siempre
 * `$queryRaw` con template tags o `Prisma.sql`.
 */

import { prisma } from '@compras-whatsapp/db';
import { Prisma } from '@compras-whatsapp/db';
import type { ItemCompra } from '@compras-whatsapp/db';

import type {
  ItemCompraRepository,
  NewItemCompra,
} from '../../domain/repositories/ItemCompraRepository.ts';
import type { PrismaClientLike } from './PrismaClientLike.ts';

export class PrismaItemCompraRepository implements ItemCompraRepository {
  constructor(private readonly db: PrismaClientLike = prisma as unknown as PrismaClientLike) {}

  async createMany(items: NewItemCompra[]): Promise<ItemCompra[]> {
    // Cast: createMany retorna { count }, pero el dominio espera el array.
    // Recargamos con findMany para devolver los rows insertados con sus
    // defaults (id, updatedAt, etc.).
    await this.db.itemCompra.createMany({ data: items });
    // Devolvemos los items recién creados buscando por compraId.
    const compraIds = [...new Set(items.map((i) => i.compraId))];
    const dbAny = this.db as unknown as {
      itemCompra: { findMany: (a: unknown) => Promise<ItemCompra[]> };
    };
    const created = await dbAny.itemCompra.findMany({
      where: { compraId: { in: compraIds } },
      orderBy: { updatedAt: 'desc' },
    });
    return created;
  }

  async findByNombre(nombre: string): Promise<ItemCompra[]> {
    const dbAny = this.db as unknown as {
      itemCompra: { findMany: (a: unknown) => Promise<ItemCompra[]> };
    };
    return dbAny.itemCompra.findMany({
      where: { nombre: nombre.toLowerCase() },
    });
  }

  async findRecentByNombre(
    nombre: string,
    minSimilarity = 0.4,
  ): Promise<(ItemCompra & { similarity: number }) | null> {
    // Normalizamos: la columna `nombre` se guarda lowercase en seed/parser.
    const normalized = nombre.toLowerCase();
    // Prisma.sql template: los placeholders $1, $2, $3 se escapan vía Prisma.
    const rows = (await this.db.$queryRaw(
      Prisma.sql`
        SELECT
          i.*,
          similarity(i.nombre, ${normalized}) AS similarity
        FROM "ItemCompra" AS i
        WHERE similarity(i.nombre, ${normalized}) > ${minSimilarity}
        ORDER BY similarity DESC, i."updatedAt" DESC
        LIMIT 1
      `,
    )) as Array<ItemCompra & { similarity: number }>;
    return rows[0] ?? null;
  }

  async updateById(
    id: string,
    data: Partial<{
      nombre: string;
      cantidadLote: number;
      unidad: string;
      costoLote: string;
      costoUnitario: string;
      precioVenta: string;
      gananciaUnitaria: string;
      gananciaTotal: string;
    }>,
  ): Promise<ItemCompra> {
    const dbAny = this.db as unknown as {
      itemCompra: { update: (a: unknown) => Promise<ItemCompra> };
    };
    return dbAny.itemCompra.update({
      where: { id },
      data,
    });
  }

  async deleteByNombreAndUsuarioId(nombre: string, usuarioId: string): Promise<number> {
    // Buscamos los IDs de las compras del usuario que tienen items con ese nombre
    const comprasConItem = await this.db.compra.findMany({
      where: { usuarioId },
      select: { id: true },
    }) as Array<{ id: string }>;

    if (comprasConItem.length === 0) return 0;

    // Eliminamos los items con ese nombre en las compras del usuario
    const dbAny = this.db as unknown as {
      itemCompra: {
        deleteMany: (a: unknown) => Promise<{ count: number }>;
      };
    };
    const result = await dbAny.itemCompra.deleteMany({
      where: {
        nombre: nombre.toLowerCase(),
        compraId: { in: comprasConItem.map((c) => c.id) },
      },
    });

    // Limpiamos compras que quedaron sin items
    const comprasVacias = await this.db.compra.findMany({
      where: { usuarioId },
      select: { id: true, items: { select: { id: true } } },
    }) as Array<{ id: string; items: Array<{ id: string }> }>;

    for (const c of comprasVacias) {
      if (c.items.length === 0) {
        await this.db.compra.deleteMany({ where: { id: c.id } });
      }
    }

    return result.count;
  }
}

// Helper exportado para tests que quieran instanciar con el client real
// tipado correctamente (no necesitan el structural subset).
export {};
