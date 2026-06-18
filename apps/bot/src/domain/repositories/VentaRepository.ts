/**
 * Puerto (interface) del repositorio de Venta.
 *
 * Definido en domain; implementado en infrastructure/persistence con Prisma.
 * La capa de aplicación (use cases) consume esta interface, nunca el
 * client Prisma directo — eso es la inversión de dependencia de Clean.
 */

import type { Venta } from '@compras-whatsapp/db';

export interface VentaRepository {
  /**
   * Crea una Venta.
   */
  create(data: {
    usuarioId: string;
    productoNombre: string;
    cantidad: number;
    precioVenta: string;
    costoUnitario: string;
    gananciaUnitaria: string;
    gananciaTotal: string;
  }): Promise<Venta>;

  /**
   * Lista las ventas de un usuario, ordenadas por fecha DESC.
   */
  findByUsuarioId(usuarioId: string, limit?: number): Promise<Venta[]>;

  /**
   * Lista las ventas de un usuario filtradas por nombre de producto.
   */
  findByProductoNombre(usuarioId: string, nombre: string): Promise<Venta[]>;

  /**
   * Suma total de ingresos (precioVenta * cantidad) de un usuario.
   * Devuelve null si no hay ventas.
   */
  sumIngresos(usuarioId: string): Promise<number | null>;

  /**
   * Suma total de gananciaTotal de un usuario.
   * Devuelve null si no hay ventas.
   */
  sumGananciaTotal(usuarioId: string): Promise<number | null>;
}
