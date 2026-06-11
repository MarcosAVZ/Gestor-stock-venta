/**
 * @compras-whatsapp/shared — punto de entrada público del paquete.
 *
 * Expone enums reusables (ConversationState, Unidad, Moneda) y
 * schemas Zod reusables (cantidad, precio, opcionUnidad, opcionSiNo).
 */

export const VERSION = '0.1.0';

// Enums reusables.
export {
  ConversationState,
  type ConversationStateType,
  Moneda,
  type MonedaType,
} from './enums/index.ts';
// Unidad re-exportado desde el enum (single source of truth).
export { Unidad, type UnidadType } from './enums/Unidad.ts';

// Schemas Zod reusables.
export {
  cantidadSchema,
  precioSchema,
  parsePrecioString,
  MAX_PRECIO_ARS_VALUE,
  opcionUnidadSchema,
  opcionSiNoSchema,
  SI_TEXTO,
  NO_TEXTO,
  UnidadSchema,
  type Cantidad,
  type Precio,
  type OpcionUnidad,
  type OpcionSiNo,
} from './schemas/index.ts';
