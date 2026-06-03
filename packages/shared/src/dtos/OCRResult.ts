/**
 * @compras-whatsapp/shared — OCRResult DTO + Zod schema.
 *
 * POR QUÉ ACÁ Y NO EN `apps/bot`: el `OCRResult` cruza la frontera
 * entre el worker OCR (infrastructure) y el use case (application).
 * Además, si en el futuro agregamos un dashboard web, va a querer
 * leer este mismo tipo. Lo compartimos desde `@compras-whatsapp/shared`
 * para tener UNA definición validada con Zod.
 *
 * Decisión de diseño (sdd-design obs#28 sección 4.1):
 * - `productos` es un array: una imagen de Temu puede tener varios items.
 *   Para MVP, el primer producto es el que se usa para la conversación;
 *   los demás se persisten en ItemCompra si hay un save multi-item.
 * - `confianza` por producto: 0-1, Tesseract devuelve un score 0-100,
 *   normalizamos dividiendo por 100.
 * - `precio`, `cantidad`, `unidad` son nullable: el OCR puede no detectar
 *   alguno. El parser es el responsable de la heurística final.
 * - `textoCompleto` SIEMPRE presente: el parser lo re-procesa si
 *   quiere aplicar heurísticas nuevas sin re-correr OCR.
 * - `tiempoMs`: para logging/metrics; permite detectar regresiones
 *   de performance del pipeline.
 *
 * Validación Zod: si Tesseract devuelve algo fuera de este schema
 * (ej: confianza > 1, nombre vacío), el parser lo rechaza con error
 * "no_detectado" — fail-fast en vez de propagar basura al state machine.
 */

import { z } from 'zod';
import { Unidad } from '../enums/Unidad.ts';

/** Unidad normalizada al enum de Prisma (const object). */
export const UnidadSchema = z.enum([
  Unidad.UNIDAD,
  Unidad.PAR,
  Unidad.PACK,
  Unidad.CAJA,
  Unidad.LOTE,
  Unidad.OTRO,
]);
export type { Unidad };

/** Producto detectado por OCR (un item en la captura). */
export const OCRProductSchema = z.object({
  nombre: z.string().min(1),
  precio: z.number().nullable(),
  cantidad: z.number().int().positive().nullable(),
  unidad: UnidadSchema.nullable(),
  confianza: z.number().min(0).max(1),
});
export type OCRProduct = z.infer<typeof OCRProductSchema>;

/** Resultado completo de una corrida OCR. */
export const OCRResultSchema = z.object({
  productos: z.array(OCRProductSchema),
  textoCompleto: z.string(),
  tiempoMs: z.number().int().nonnegative(),
  confianzaPromedio: z.number().min(0).max(1),
});
export type OCRResult = z.infer<typeof OCRResultSchema>;

/** Producto "vacío" usado por el parser cuando no detecta nada. */
export const EMPTY_OCR_RESULT: OCRResult = {
  productos: [],
  textoCompleto: '',
  tiempoMs: 0,
  confianzaPromedio: 0,
};
