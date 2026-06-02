/**
 * @compras-whatsapp/bot — imagePreprocessor (sharp).
 *
 * POR QUÉ EXISTE: las capturas de WhatsApp/Temu/Shein vienen en JPEG
 * comprimido, con tipografías pequeñas y fondos con ruido. Tesseract
 * legacy engine performa ~30% mejor con imágenes binarizadas (B&W)
 * y de alto contraste. Este módulo aplica el pipeline canónico
 * (sdd-design obs#28 sección 5 "Pre-procesamiento con sharp"):
 *
 *   1. `resize`     → max 1280px ancho (reduce pixeles, OCR no necesita más)
 *   2. `grayscale`  → elimina canal de color (Tesseract solo lee luminancia)
 *   3. `normalise`  → estira contraste (corrige imágenes oscuras/claras)
 *   4. `sharpen`    → recupera bordes que el JPEG softening
 *   5. `threshold`  → binariza (B&W puro) para Tesseract legacy engine
 *
 * Output: PNG buffer (lossless, Tesseract lo prefiere sobre JPEG).
 *
 * El módulo NO valida la imagen (eso es responsabilidad del caller).
 * Si el path no existe, sharp tira con un error descriptivo y el
 * caller (use case) lo traduce a OperationalError.
 *
 * OCP: si en el futuro queremos cambiar el pipeline (ej: usar
 * `linear` en vez de `normalise`), se modifica acá sin tocar el
 * resto del código gracias a la firma simple `preprocess(inputPath)`.
 */

import sharp from 'sharp';

// ── Constantes del pipeline (testeables individualmente) ─────────────

/** Ancho máximo del output. Imágenes más chicas no se agrandan. */
export const MAX_WIDTH_PX = 1280;

/** Sigma del `sharpen` (1 = sutil, suficiente para JPEG softening). */
export const SHARPEN_SIGMA = 1;

/**
 * Threshold binario (0-255). 150 es agresivo pero funciona bien para
 * capturas de precios sobre fondo claro. Ajustar si vemos demasiado
 * ruido o demasiado detalle perdido.
 */
export const THRESHOLD_VALUE = 150;

// ── API pública ─────────────────────────────────────────────────────

/**
 * Aplica el pipeline de pre-procesamiento y retorna un PNG buffer
 * listo para Tesseract.
 *
 * @param inputPath - Path absoluto a la imagen descargada
 *   (`data/images/<phone>/<ts>.jpg`).
 * @returns PNG buffer 1280px ancho (si el original era más grande),
 *   grayscale, contraste normalizado, sharpened, binarizado.
 *
 * @example
 *   const buffer = await preprocess('/data/images/54911.../123.jpg');
 *   // → Buffer (PNG, ~200-500KB)
 *   await tesseractWorker.recognize(buffer);
 */
export async function preprocess(inputPath: string): Promise<Buffer> {
  return sharp(inputPath)
    .resize({ width: MAX_WIDTH_PX, withoutEnlargement: true })
    .grayscale()
    .normalise()
    .sharpen({ sigma: SHARPEN_SIGMA })
    .threshold(THRESHOLD_VALUE)
    .png()
    .toBuffer();
}
