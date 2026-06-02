/**
 * Adapter Prisma para `UsuarioRepository`.
 *
 * Implementación thin: una llamada a `db.usuario.X` por método.
 * Convenciones:
 * - `findByTelefono` y `findById` devuelven `null` si no encuentran
 *   (la interface lo promete así; la conversión a `NotFoundError`
 *   sucede en la capa de aplicación cuando `null` es semánticamente
 *   "debería existir y no está").
 * - `create` deja que la unique constraint de `telefono` tire `P2002`
 *   y la propaga; la conversión a `ValidationError` sucede en la
 *   capa de aplicación.
 *
 * Recibe un `PrismaClientLike` por constructor (default: el singleton
 * de `@compras-whatsapp/db`). En tests, se inyecta un mock con
 * `vi.mock('./PrismaClientLike')` o pasando un fake.
 */

import { prisma } from '@compras-whatsapp/db';
import type { Usuario } from '@compras-whatsapp/db';

import type { UsuarioRepository } from '../../domain/repositories/UsuarioRepository.ts';
import type { PrismaClientLike } from './PrismaClientLike.ts';

export class PrismaUsuarioRepository implements UsuarioRepository {
  constructor(private readonly db: PrismaClientLike = prisma as unknown as PrismaClientLike) {}

  async findByTelefono(telefono: string): Promise<Usuario | null> {
    return this.db.usuario.findUnique({ where: { telefono } });
  }

  async findById(id: string): Promise<Usuario | null> {
    return this.db.usuario.findUnique({ where: { id } });
  }

  async create(data: { telefono: string; nombre?: string }): Promise<Usuario> {
    return this.db.usuario.create({ data });
  }
}
