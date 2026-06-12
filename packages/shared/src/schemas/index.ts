/**
 * @compras-whatsapp/shared — barrel export de schemas Zod.
 *
 * Re-exporta los schemas y tipos públicos del paquete. El consumo
 * es:
 *   import { cantidadSchema, precioSchema, ... } from '@compras-whatsapp/shared';
 */
export { cantidadSchema, type Cantidad } from './cantidad.ts';
export {
  precioSchema,
  parsePrecioString,
  MAX_PRECIO_ARS_VALUE,
  type Precio,
} from './precio.ts';
export { opcionUnidadSchema, type OpcionUnidad } from './opcionUnidad.ts';
export { opcionSiNoSchema, type OpcionSiNo, SI_TEXTO, NO_TEXTO } from './opcionSiNo.ts';
export { UnidadSchema } from './unidad.ts';
