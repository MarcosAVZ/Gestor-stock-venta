/**
 * Puerto (interface) del repositorio de Usuario.
 *
 * Vive en `apps/bot/src/domain/repositories/` y NO depende de Prisma.
 * La implementación Prisma está en
 * `apps/bot/src/infrastructure/persistence/PrismaUsuarioRepository.ts`.
 *
 * Los tipos de retorno (Usuario) se importan de `@compras-whatsapp/db`,
 * que re-exporta los tipos generados por Prisma. Esto es deliberado:
 * el dominio no debería conocer la persistencia, pero SÍ necesita la
 * forma de los datos. Prisma genera tipos estructurales puros que no
 * acoplan el dominio a un ORM concreto.
 */

import type { Usuario } from '@compras-whatsapp/db';

export interface UsuarioRepository {
  /**
   * Busca un usuario por su teléfono en formato E.164.
   * @returns el Usuario si existe, `null` si no.
   */
  findByTelefono(telefono: string): Promise<Usuario | null>;

  /**
   * Busca un usuario por su id (cuid).
   * @returns el Usuario si existe, `null` si no.
   */
  findById(id: string): Promise<Usuario | null>;

  /**
   * Crea un usuario nuevo. Lanza error si el teléfono ya existe
   * (la constraint UNIQUE en BD lo bloquea).
   */
  create(data: { telefono: string; nombre?: string }): Promise<Usuario>;
}
