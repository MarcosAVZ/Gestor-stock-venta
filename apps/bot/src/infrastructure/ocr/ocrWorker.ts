/**
 * @compras-whatsapp/bot — ocrWorker.ts (código del worker thread).
 *
 * POR QUÉ EXISTE: Tesseract.js carga ~30MB de WASM y procesa 3-10s
 * por imagen. Si lo corriéramos en el main thread, BLOQUEARÍA el
 * event loop del bot: otros usuarios no responderían, el rate limiter
 * no avanzaría, el healthcheck HTTP se colgaría.
 *
 * Solución: correr Tesseract en un `node:worker_threads` con un pool
 * de 2 workers (config `OCR_CONCURRENCY`). El main thread envía el
 * buffer de la imagen via `parentPort.postMessage`, el worker hace
 * el `recognize()`, y devuelve el resultado.
 *
 * PROTOCOLO IPC (ver TesseractExtractor para el lado del main):
 *   Main → Worker:  { type: 'recognize', buffer: Uint8Array, requestId: string }
 *   Worker → Main:  { type: 'result', text: string, confidence: number, tiempoMs: number, requestId: string }
 *   Worker → Main:  { type: 'error', message: string, requestId: string }
 *
 * NOTA: el `lang` se hardcodea a `spa+eng` (es-AR + inglés como
 * fallback para nombres de productos importados). El Dockerfile
 * incluye `tesseract-ocr-spa` (PR5 task 5.13). En tests este worker
 * NO se levanta (TesseractExtractor recibe un factory inyectable).
 */

import { parentPort } from 'node:worker_threads';

import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';

import { logSecurityEvent } from '../logging/logger.ts';
import { safeLogger } from '../logging/safeLogger.ts';

// ── Tipos del protocolo IPC ──────────────────────────────────────────

interface RecognizeRequest {
  type: 'recognize';
  buffer: ArrayBuffer;
  requestId: string;
}

interface ResultMessage {
  type: 'result';
  text: string;
  confidence: number;
  tiempoMs: number;
  requestId: string;
}

interface ErrorMessage {
  type: 'error';
  message: string;
  requestId: string;
  timeout?: boolean;
}

type IncomingMessage = RecognizeRequest;
type OutgoingMessage = ResultMessage | ErrorMessage;

// ── Constantes ───────────────────────────────────────────────────────

/** Idiomas cargados. spa primario, eng fallback para productos en inglés. */
const TESSERACT_LANGS = 'spa+eng';

// ── Bootstrap del worker ─────────────────────────────────────────────

if (parentPort === null) {
  // Esto no debería pasar: este archivo SOLO se carga desde un
  // worker_thread. Si llega al main thread, fallamos LO ANTES POSIBLE.
  throw new Error('ocrWorker: parentPort is null — must be loaded in a worker_thread');
}

/**
 * Wrapper minimal sobre Tesseract.js. Lo creamos una vez por worker
 * (Tesseract.js es caro de inicializar, ~500ms).
 */
let tesseractWorker: TesseractWorker | null = null;

async function getTesseractWorker(): Promise<TesseractWorker> {
  if (tesseractWorker !== null) return tesseractWorker;
  tesseractWorker = await createWorker(TESSERACT_LANGS, 1, {
    // Sin logger para evitar ruido en el worker (los logs van al main).
    logger: () => undefined,
  });
  return tesseractWorker;
}

// ── Handlers ─────────────────────────────────────────────────────────

parentPort.on('message', async (msg: IncomingMessage) => {
  if (msg.type !== 'recognize') {
    return; // protocolo desconocido, ignoramos
  }
  const { buffer, requestId } = msg;
  const startedAt = Date.now();
  try {
    const worker = await getTesseractWorker();
    // Tesseract.js acepta ImageLike (string | HTMLCanvasElement | HTMLImageElement | Buffer | ...)
    // Le pasamos un Buffer. El cast es seguro porque Buffer extends Uint8Array.
    const result = await worker.recognize(Buffer.from(buffer));
    const tiempoMs = Date.now() - startedAt;
    const response: OutgoingMessage = {
      type: 'result',
      text: result.data.text,
      confidence: result.data.confidence / 100, // Tesseract devuelve 0-100, normalizamos
      tiempoMs,
      requestId,
    };
    parentPort!.postMessage(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logSecurityEvent(safeLogger(), 'unhandled_rejection', {
      context: 'ocrWorker',
      err: message,
    });
    const response: OutgoingMessage = {
      type: 'error',
      message,
      requestId,
    };
    parentPort!.postMessage(response);
  }
});

/**
 * Cleanup al recibir `closeMessage` (graceful shutdown).
 * Sin esto, el worker thread queda zombie consumiendo memoria.
 */
parentPort.on('close', async () => {
  if (tesseractWorker !== null) {
    try {
      await tesseractWorker.terminate();
    } catch {
      // ignore — el proceso está cerrándose
    }
  }
  process.exit(0);
});
