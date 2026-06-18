/**
 * Puerto (interface) del repositorio de Compra.
 *
 * Definido en domain; implementado en infrastructure/persistence con Prisma.
 * La capa de aplicación (use cases) consume esta interface, nunca el
 * client Prisma directo — eso es la inversión de dependencia de Clean.
 */

import type { Compra, Moneda, ItemCompra } from '@compras-whatsapp/db';

export interface CompraRepository {
  /**
   * Crea una Compra vacía (sin items). Los items se insertan después
   * vía `ItemCompraRepository.createMany`.
   */
  create(data: {
    usuarioId: string;
    imagenOriginal?: string;
    moneda?: Moneda;
  }): Promise<Compra>;

  /**
   * Busca una Compra por id. NO carga los items (eso lo hace
   * `findByIdWithItems` cuando hace falta). Devuelve `null` si no existe.
   */
  findById(id: string): Promise<Compra | null>;

  /**
   * Busca una Compra por id con sus items eager-loaded. Devuelve `null`
   * si no existe.
   */
  findByIdWithItems(id: string): Promise<(Compra & { items: ItemCompra[] }) | null>;

  /**
   * Lista las compras de un usuario, ordenadas por fecha DESC.
   * `limit` por defecto 100 (uso normal: resúmenes, no auditoría).
   */
  findByUsuarioId(usuarioId: string, limit?: number): Promise<Compra[]>;

  /**
   * Lista las compras en un rango de fechas (inclusive). Usado para
   * "compras mes" y otros reportes por periodo. Orden DESC por fecha.
   */
  findByDateRange(opts: { from: Date; to: Date }): Promise<Compra[]>;

  /**
   * Top items por gananciaUnitaria (cross-usuario). Usado por el
   * comando "top ganancias". Devuelve items ordenados con sus compras
   * para que el caller pueda agregar por nombre si hace falta.
   */
  findTopByGanancias(limit: number): Promise<ItemCompra[]>;

  /**
   * Elimina todas las compras de un usuario (y sus items por cascade).
   * Usado por el comando /eliminar.
   */
  deleteAllByUsuarioId(usuarioId: string): Promise<number>;
}
