/**
 * @compras-whatsapp/bot — ValidateOCRData (use case).
 *
 * RESPONSABILIDAD:
 * Cuando llega una imagen y el estado es `ESPERANDO_IMAGEN`, este use
 * case ejecuta el pipeline OCR (`ExtractPurchaseData`), guarda el
 * resultado en `Conversacion.datosTemporales`, y devuelve el prompt
 * voseo de confirmación para que el usuario valide.
 *
 * Es la pieza que faltaba en PR3+PR4: el state machine ya tenía la
 * transición `ESPERANDO_IMAGEN + IMAGEN_RECIBIDA → VALIDANDO_DATOS` con
 * acción `DISPARAR_OCR`, pero la implementación real del OCR estaba
 * sin wirear. PR5 cierra ese gap.
 *
 * POR QUÉ UN USE CASE SEPARADO:
 * - Testeable con mocks de `ExtractPurchaseData` y `ConversacionRepository`.
 * - Reusable desde el dispatcher si en el futuro queremos invocarlo
 *   sin pasar por el state machine (ej: retry manual desde un comando).
 * - Mantiene `HandleIncomingMessage` liviano: este use case es
 *   responsable de la lectura del archivo + OCR + persistencia; el
 *   orquestador solo llama y muestra el resultado.
 *
 * DECISIONES:
 * - Si OCR falla (`OcrFailedError` / `OcrTimeoutError`), retornamos
 *   un prompt amigable y NO mutamos el estado: el usuario puede
 *   reenviar la imagen.
 * - El `requestId` se pasa para correlación de logs (PR4 ya lo hace).
 * - Lee el buffer desde `imagePath` con `fs.readFile` (sync). El
 *   dispatcher ya descargó la imagen a disco en PR4; re-leer es OK
 *   porque sharp + tesseract se van a comer el archivo igual.
 */
import { readFile } from 'node:fs/promises';

import type { Logger } from 'pino';

import type { ConversacionRepository } from '../../domain/repositories/ConversacionRepository.ts';
import type { ExtractPurchaseData, ImagePreprocessor } from '../ocr/ExtractPurchaseData.ts';
import type { OCRExtractor } from '../ocr/interfaces/OCRExtractor.ts';
import { parseOCRText } from '../../infrastructure/ocr/ocrParser.ts';
import { OCRResultSchema, type OCRResult } from '@compras-whatsapp/shared';
import { logSecurityEvent } from '../../infrastructure/logging/logger.ts';
import { OcrFailedError, OcrTimeoutError } from '../../domain/errors/OperationalError.ts';

// ── Input / Output ───────────────────────────────────────────────────

export interface ValidateOCRDataDeps {
  /** Logger estructurado. */
  logger: Logger;
  /** Repo para persistir el resultado OCR en datosTemporales. */
  conversacionRepo: ConversacionRepository;
  /** Preprocesador de imagen (sharp). */
  preprocessor: ImagePreprocessor;
  /** Extractor OCR (Tesseract). */
  extractor: OCRExtractor;
  /** Parser de OCRResult (con textoCompleto) → productos estructurados. */
  parser?: (raw: OCRResult) => OCRResult;
}

export interface ValidateOCRDataInput {
  /** ID del usuario (no el phone, sino el PK de la DB). */
  usuarioId: string;
  /** Path a la imagen ya descargada por el dispatcher. */
  imagePath: string;
  /** Request ID para correlación de logs. */
  requestId: string;
}

export interface ValidateOCRDataOutput {
  /** Mensaje voseo a enviar al usuario (texto formateado). */
  prompt: string;
  /** Resultado del OCR (para que el caller lo persista si quiere). */
  ocrResult: OCRResult;
  /** Si el OCR falló (en cuyo caso el caller NO debe avanzar de estado). */
  failed: boolean;
}

// ── Use case ─────────────────────────────────────────────────────────

/**
 * Ejecuta el pipeline OCR sobre la imagen, valida el resultado con
 * Zod, y devuelve un prompt voseo para que el usuario confirme.
 *
 * @throws {InvariantViolationError} si el path no existe (no se
 *   debería llegar acá porque el dispatcher ya lo validó).
 */
export async function validateOCRData(
  input: ValidateOCRDataInput,
  deps: ValidateOCRDataDeps,
): Promise<ValidateOCRDataOutput> {
  const { logger, preprocessor, extractor, conversacionRepo, parser = parseOCRText } = deps;
  const { usuarioId, imagePath, requestId } = input;

  // 1. Leer el buffer desde disco.
  let buffer: Buffer;
  try {
    buffer = await readFile(imagePath);
  } catch (err) {
    logger.error(
      { event: 'ocr_image_read_failed', requestId, imagePath, err: (err as Error).message },
      'no se pudo leer la imagen del disco',
    );
    throw new OcrFailedError('No pude abrir la imagen. ¿La reenviás?', {
      metadata: { imagePath, requestId },
    });
  }

  // 2. Ejecutar OCR (preprocess + extract + parse).
  const t0 = Date.now();
  let ocrResult: OCRResult;
  try {
    const preprocessed = await preprocessor.preprocess(buffer);
    const raw = await extractor.extract(preprocessed, requestId);
    ocrResult = parser(raw);
    // Validamos con Zod (defensa contra shape inválido).
    const parsed = OCRResultSchema.safeParse(ocrResult);
    if (!parsed.success) {
      logSecurityEvent(logger, 'ocr_failed', { requestId, reason: 'zod_parse_failed' });
      return {
        prompt: 'No pude leer bien la imagen. ¿Me la reenviás?',
        ocrResult: OCRResultSchema.parse({ productos: [], textoCompleto: '', tiempoMs: 0, confianzaPromedio: 0 }),
        failed: true,
      };
    }
    ocrResult = parsed.data;
  } catch (err) {
    const e = err as Error;
    if (e instanceof OcrTimeoutError) {
      logSecurityEvent(logger, 'ocr_failed', { requestId, reason: 'timeout' });
      return {
        prompt: 'La imagen tardó demasiado. ¿La reenviás?',
        ocrResult: { productos: [], textoCompleto: '', tiempoMs: Date.now() - t0, confianzaPromedio: 0 },
        failed: true,
      };
    }
    logSecurityEvent(logger, 'ocr_failed', { requestId, reason: e.message });
    return {
      prompt: 'No pude leer bien la imagen. ¿Me la reenviás o cargamos manualmente?',
      ocrResult: { productos: [], textoCompleto: '', tiempoMs: Date.now() - t0, confianzaPromedio: 0 },
      failed: true,
    };
  }

  // 3. Persistir el resultado en datosTemporales.
  // Tomamos el primer producto (MVP: una imagen = un item).
  const primerProducto = ocrResult.productos[0];
  if (primerProducto === undefined || primerProducto.nombre === '') {
    logSecurityEvent(logger, 'ocr_failed', { requestId, reason: 'no_product_detected' });
    return {
      prompt: 'No detecté un producto claro en la imagen. ¿Me la reenviás?',
      ocrResult,
      failed: true,
    };
  }

  const datos: Record<string, unknown> = {
    producto: primerProducto.nombre.toLowerCase().trim(),
    costoLote: primerProducto.precio ?? null,
    ocrConfianza: primerProducto.confianza,
    ocrTextoCompleto: ocrResult.textoCompleto,
    ocrTiempoMs: ocrResult.tiempoMs,
  };
  // Si el OCR detectó cantidad + unidad, los guardamos como sugerencia.
  if (primerProducto.cantidad !== null) datos['cantidadSugerida'] = primerProducto.cantidad;
  if (primerProducto.unidad !== null) datos['unidadSugerida'] = primerProducto.unidad;

  await conversacionRepo.update(usuarioId, { datosTemporales: datos });

  const costoLote = primerProducto.precio ?? 0;
  // Usamos el nombre normalizado (lowercase) en el prompt para que
  // matchee con lo que persistimos en `datosTemporales` y el usuario
  // vea exactamente lo que el sistema entendió.
  const nombreDisplay = datos['producto'] as string;
  const prompt =
    costoLote > 0
      ? `Detecté: ${nombreDisplay}, costo lote $${costoLote.toLocaleString('es-AR')}. ` +
        `¿Es correcto? 1. Sí 2. No`
      : `Detecté: ${nombreDisplay}, pero no pude leer el precio. ` +
        `¿Es correcto? 1. Sí 2. No`;

  logger.info(
    {
      event: 'ocr_validated',
      requestId,
      producto: datos['producto'],
      costoLote,
      confianza: primerProducto.confianza,
      tiempoMs: Date.now() - t0,
    },
    'OCR validated and persisted',
  );

  return { prompt, ocrResult, failed: false };
}

// Re-export del tipo para callers que quieran mockearlo.
export type { ExtractPurchaseData, OCRExtractor, ImagePreprocessor };
