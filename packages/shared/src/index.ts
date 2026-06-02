/**
 * @compras-whatsapp/shared — punto de entrada público del paquete.
 *
 * En PR1 expone únicamente la constante VERSION para validar que
 * el path resolution y el type stripping funcionan end-to-end.
 * A partir de PR3 se agregan: Zod schemas, AppError hierarchy,
 * constantes de ConversationState, DTOs.
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
