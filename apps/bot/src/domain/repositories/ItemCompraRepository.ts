/**
 * Puerto (interface) del repositorio de ItemCompra.
 *
 * Los items son líneas dentro de una Compra (medias negras 12 pares a
 * $1500 c/u). Persisten junto a la compra con onDelete: Cascade desde
 * Compra, pero este repositorio trabaja a nivel de item porque la
 * función de aprendizaje (PR5) y los comandos de consulta hacen queries
 * por nombre independiente de la compra.
 */

import type { ItemCompra, Unidad } from '@compras-whatsapp/db';

/** Datos necesarios para crear un item (la Compra padre ya existe). */
export type NewItemCompra = {
  compraId: string;
  nombre: string;
  cantidadLote: number;
  unidad: Unidad;
  costoLote: string; // Decimal serializado a string (Prisma convention)
  costoUnitario: string;
  precioVenta: string;
  gananciaUnitaria: string;
  gananciaTotal: string;
};

export interface ItemCompraRepository {
  /**
   * Inserta varios items en una sola transacción.
   * Usado por SaveCompra (PR5) después de crear la Compra padre.
   */
  createMany(items: NewItemCompra[]): Promise<ItemCompra[]>;

  /**
   * Busca items por nombre exacto (lowercase). Usado por el parser OCR
   * cuando el texto tiene alta confianza y se quiere lookup directo
   * antes que fuzzy match.
   */
  findByNombre(nombre: string): Promise<ItemCompra[]>;

  /**
   * Busca el item más reciente con un nombre similar al dado.
   * Implementación por default: usa fuzzy match con `pg_trgm` y
   * `similarity() > 0.4` (threshold locked en sdd-design obs#28,
   * sección 7). Retorna `null` si no hay match por encima del umbral.
   *
   * El parámetro `minSimilarity` permite a tests/casos especiales bajar
   * el umbral (default 0.4).
   */
  findRecentByNombre(
    nombre: string,
    minSimilarity?: number,
  ): Promise<(ItemCompra & { similarity: number }) | null>;
}
