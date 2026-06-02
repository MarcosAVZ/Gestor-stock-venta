/**
 * @compras-whatsapp/bot — OCRExtractor port (interface).
 *
 * POR QUÉ EXISTE: el dominio (use case `ExtractPurchaseData`) NO
 * quiere acoplarse a tesseract.js ni a la forma del worker. Esta
 * interface es el PUERTO que el dominio consume; la implementación
 * concreta (`TesseractExtractor`) vive en `infrastructure/ocr/`.
 *
 * Esto cumple Dependency Inversion: el dominio depende de una
 * abstracción, no de la lib. Migrar a Google Cloud Vision o AWS
 * Textract en el futuro es solo crear otra implementación.
 *
 * El output es `OCRResult` (definido en `packages/shared`). Los
 * productos extraídos están normalizados y validados con Zod; el
 * parser post-OCR es responsable de mapear el texto crudo a la
 * estructura final.
 *
 * Decisión de diseño: el extractor retorna `textoCompleto` crudo
 * además de la lista de productos. Esto permite:
 *   1. Re-parsear con heurísticas mejoradas sin re-correr OCR (caro).
 *   2. Logging/debugging del texto detectado.
 *   3. Validar manualmente con fixtures.
 *
 * El extractor NO aplica la heurística de producto/cantidad: eso es
 * responsabilidad del parser (separación de concerns).
 */

import type { OCRResult } from '@compras-whatsapp/shared';

/**
 * Puerto que el dominio consume. NO depende de tesseract.js ni de
 * la API de workers de Node.
 */
export interface OCRExtractor {
  /**
   * Extrae datos de una imagen pre-procesada.
   *
   * @param imageBuffer - PNG buffer ya normalizado por el preprocessor.
   *   El extractor NO llama a sharp internamente — el use case
   *   (`ExtractPurchaseData`) se encarga de pre-procesar primero.
   * @param requestId - ID de correlación (para logs/timeout). Opcional.
   * @returns `OCRResult` con texto crudo, tiempo, y productos
   *   extraídos (puede ser array vacío si la confianza fue muy baja).
   *
   * @throws {OcrTimeoutError} si el OCR tarda más de `timeoutMs`.
   * @throws {OcrFailedError} si el worker crashea o devuelve error.
   */
  extract(imageBuffer: Buffer, requestId?: string): Promise<OCRResult>;

  /**
   * Cierra el pool de workers. Idempotente. El container lo llama
   * en graceful shutdown (PR3 task 3.12).
   */
  destroy(): Promise<void>;
}
