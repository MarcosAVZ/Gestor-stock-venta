/**
 * Adapter Prisma para `VentaRepository`.
 *
 * Implementación thin: una llamada a `db.venta.X` por método.
 * Convenciones:
 * - `findByUsuarioId` ordena por fecha DESC (ventas recientes primero).
 * - `findByProductoNombre` filtra por usuarioId + productoNombre exacto.
 * - `sumIngresos` y `sumGananciaTotal` usan `aggregate` con `_sum`.
 * - `create` recibe strings para Decimals (Prisma los parsea).
 *
 * Recibe un `PrismaClientLike` por constructor (default: el singleton
 * de `@compras-whatsapp/db`). En tests, se inyecta un mock.
 */

import { prisma } from '@compras-whatsapp/db';
import type { Venta } from '@compras-whatsapp/db';

import type { VentaRepository } from '../../domain/repositories/VentaRepository.ts';
import type { PrismaClientLike } from './PrismaClientLike.ts';

export class PrismaVentaRepository implements VentaRepository {
  constructor(private readonly db: PrismaClientLike = prisma as unknown as PrismaClientLike) {}

  async create(data: {
    usuarioId: string;
    productoNombre: string;
    cantidad: number;
    precioVenta: string;
    costoUnitario: string;
    gananciaUnitaria: string;
    gananciaTotal: string;
  }): Promise<Venta> {
    const created = (await this.db.venta.create({ data })) as Venta;
    return created;
  }

  async findByUsuarioId(usuarioId: string, limit = 100): Promise<Venta[]> {
    return (await this.db.venta.findMany({
      where: { usuarioId },
      orderBy: { fecha: 'desc' },
      take: limit,
    })) as Venta[];
  }

  async findByProductoNombre(usuarioId: string, nombre: string): Promise<Venta[]> {
    return (await this.db.venta.findMany({
      where: { usuarioId, productoNombre: nombre },
      orderBy: { fecha: 'desc' },
    })) as Venta[];
  }

  async sumIngresos(usuarioId: string): Promise<number | null> {
    const result = (await this.db.venta.aggregate({
      where: { usuarioId },
      _sum: { precioVenta: true },
    })) as { _sum: { precioVenta: { toNumber: () => number } | null } | null };
    return result._sum?.precioVenta?.toNumber() ?? null;
  }

  async sumGananciaTotal(usuarioId: string): Promise<number | null> {
    const result = (await this.db.venta.aggregate({
      where: { usuarioId },
      _sum: { gananciaTotal: true },
    })) as { _sum: { gananciaTotal: { toNumber: () => number } | null } | null };
    return result._sum?.gananciaTotal?.toNumber() ?? null;
  }
}
