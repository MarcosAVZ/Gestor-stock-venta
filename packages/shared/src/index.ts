/**
 * @compras-whatsapp/shared — punto de entrada público del paquete.
 *
 * En PR1 expone únicamente la constante VERSION para validar que
 * el path resolution y el type stripping funcionan end-to-end.
 * PR4 agregó: Zod schemas, DTOs OCR.
 * PR5 agrega: enums reusables (ConversationState, Unidad, Moneda) y
 * schemas Zod reusables (cantidad, precio, opcionUnidad, opcionSiNo).
 */

export const VERSION = '0.1.0';

// DTOs y schemas reusables (PR4).
export {
  OCRProductSchema,
  OCRResultSchema,
  UnidadSchema,
  EMPTY_OCR_RESULT,
  type OCRProduct,
  type OCRResult,
} from './dtos/OCRResult.ts';

// Enums reusables (PR5).
export {
  ConversationState,
  type ConversationStateType,
  Moneda,
  type MonedaType,
} from './enums/index.ts';
// Unidad re-exportado desde el enum (single source of truth).
export { Unidad, type UnidadType } from './enums/Unidad.ts';

// Schemas Zod reusables (PR5).
export {
  cantidadSchema,
  precioSchema,
  parsePrecioString,
  MAX_PRECIO_ARS_VALUE,
  opcionUnidadSchema,
  opcionSiNoSchema,
  SI_TEXTO,
  NO_TEXTO,
  type Cantidad,
  type Precio,
  type OpcionUnidad,
  type OpcionSiNo,
} from './schemas/index.ts';
