/**
 * `ExtractPurchaseData` — use case del pipeline OCR completo.
 *
 * RESPONSABILIDAD:
 * Orquestar el pipeline de extracción de datos de una imagen:
 *   1. Preprocesar la imagen (sharp: resize, grayscale, normalize,
 *      sharpen, threshold).
 *   2. Extraer texto vía Tesseract (worker pool).
 *   3. Parsear el texto a productos estructurados (regex heurístico).
 *
 * Devuelve un `OCRResult` con `productos` poblado. Si el pipeline
 * falla en cualquier paso, propaga un error tipado
 * (`OcrFailedError` / `OcrTimeoutError`).
 *
 * POR QUÉ EXISTE:
 * Centralizar la orquestación permite:
 * - Logging consistente (`ocr_started`, `ocr_completed`, `ocr_failed`,
 *   `ocr_timeout`) — OWASP A09 (observabilidad).
 * - Testing end-to-end del pipeline con mocks de las 3 capas.
 * - Reemplazar piezas (ej: swap Tesseract por servicio cloud) sin
 *   tocar al caller (`eventDispatcher`).
 *
 * INYECCIONES:
 * - `preprocessor`: clase con `preprocess(buffer) → Promise<Buffer>`.
 * - `extractor`: interface `OCRExtractor` (puertos `application/ocr`).
 * - `logger`: Pino.
 *
 * Si no se pasan defaults, se usan las implementaciones reales
 * (sharp + TesseractExtractor) — útil para producción. Los tests
 * pasan mocks.
 */

import type { Logger } from 'pino';
import type { OCRResult } from '@compras-whatsapp/shared';

import { OcrFailedError, OcrTimeoutError } from '../../domain/errors/OperationalError.ts';
import type { OCRExtractor } from './interfaces/OCRExtractor.ts';
import { parseOCRText } from '../../infrastructure/ocr/ocrParser.ts';

/** Interfaz mínima del preprocesador (duck-typed para no acoplar). */
export interface ImagePreprocessor {
  preprocess(buffer: Buffer): Promise<Buffer>;
}

export interface ExtractPurchaseDataDeps {
  preprocessor: ImagePreprocessor;
  extractor: OCRExtractor;
  logger: Logger;
}

export interface ExtractPurchaseDataInput {
  /** Buffer de la imagen original (decodificada por el port). */
  imageBuffer: Buffer;
  /** Request ID para correlación de logs. */
  requestId: string;
  /** Phone (E.164) del usuario, para logs estructurados. */
  phone?: string;
}

export class ExtractPurchaseData {
  private readonly preprocessor: ImagePreprocessor;
  private readonly extractor: OCRExtractor;
  private readonly logger: Logger;

  constructor(deps: ExtractPurchaseDataDeps) {
    this.preprocessor = deps.preprocessor;
    this.extractor = deps.extractor;
    this.logger = deps.logger;
  }

  async execute(input: ExtractPurchaseDataInput): Promise<OCRResult> {
    const { imageBuffer, requestId, phone } = input;
    const t0 = Date.now();
    this.logger.info(
      { event: 'ocr_started', requestId, phone, bytes: imageBuffer.length },
      'extract purchase data started',
    );

    try {
      // 1. Preprocesar imagen
      const preprocessed = await this.preprocessor.preprocess(imageBuffer);
      this.logger.debug(
        {
          event: 'ocr_preprocess_done',
          requestId,
          originalBytes: imageBuffer.length,
          preprocessedBytes: preprocessed.length,
        },
        'preprocess done',
      );

      // 2. Extraer texto con Tesseract (puede tirar OcrFailedError u OcrTimeoutError)
      const rawOcr = await this.extractor.extract(preprocessed, requestId);

      // 3. Parsear texto a productos estructurados
      const parsed = parseOCRText(rawOcr);

      const totalMs = Date.now() - t0;
      this.logger.info(
        {
          event: 'ocr_completed',
          requestId,
          phone,
          totalMs,
          ocrMs: parsed.tiempoMs,
          productos: parsed.productos.length,
          confianzaPromedio: parsed.confianzaPromedio,
        },
        'extract purchase data completed',
      );

      return parsed;
    } catch (err) {
      const e = err as Error;
      if (e instanceof OcrTimeoutError) {
        this.logger.warn(
          { event: 'ocr_timeout', requestId, phone, err: e.message },
          'OCR timed out',
        );
        throw e;
      }
      if (e instanceof OcrFailedError) {
        this.logger.error(
          { event: 'ocr_failed', requestId, phone, err: e.message },
          'OCR failed',
        );
        throw e;
      }
      this.logger.error(
        { event: 'ocr_failed', requestId, phone, err: e.message },
        'OCR pipeline failed',
      );
      throw new OcrFailedError(`OCR pipeline error: ${e.message}`);
    }
  }
}
