/**
 * @compras-whatsapp/bot — TesseractExtractor (pool de worker_threads).
 *
 * POR QUÉ EXISTE: `tesseract.js` corre dentro de un worker (ver
 * `ocrWorker.ts`). Este módulo es el ORQUESTADOR del main thread:
 * gestiona el pool de workers, distribuye requests, maneja timeouts
 * y errores, y expone la interface `OCRExtractor` que el dominio
 * consume.
 *
 * Diseño del pool:
 * - N workers configurables (default 2 = `OCR_CONCURRENCY`).
 * - Round-robin: cada request va al siguiente worker disponible.
 * - Si un worker crashea, se levanta uno nuevo en su lugar (restart).
 * - Si una request tarda más de `timeoutMs`, se `worker.terminate()`
 *   y se levanta uno nuevo (operational error `ocr_timeout`).
 * - Si la request falla (worker devuelve error), se reintenta UNA vez
 *   con el mismo worker; si vuelve a fallar, `ocr_failed`.
 *
 * Testabilidad:
 * - El constructor acepta `workerFactory` opcional. Para tests, se
 *   inyecta un factory que retorna un fake `Worker` (mocks de
 *   `node:worker_threads`). La lib real de Tesseract NO se importa
 *   en tests.
 * - `logger` y `timeoutMs` también inyectables.
 *
 * Concurrencia: con pool=2, el bot puede tener 2 OCR en paralelo.
 * Si llega un 3er request, espera a que uno se libere. Esto protege
 * la CPU del host (Tesseract consume 100% de un core por request).
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import type { Logger } from 'pino';
import type { OCRResult } from '@compras-whatsapp/shared';

import { OcrFailedError, OcrTimeoutError } from '../../domain/errors/OperationalError.ts';
import type { OCRExtractor } from '../../application/ocr/interfaces/OCRExtractor.ts';

// ── Tipos públicos ──────────────────────────────────────────────────

export interface TesseractExtractorOptions {
  /** Cantidad de workers en el pool. Default 2. */
  concurrency?: number;
  /** Timeout por request OCR (ms). Default 30000 (30s). */
  timeoutMs?: number;
  /** Logger para instrumentación. Si no, se usa safeLogger. */
  logger?: Logger;
  /**
   * Factory para crear un Worker. Default: crea un worker real
   * corriendo `ocrWorker.ts`. Los tests inyectan un fake factory.
   */
  workerFactory?: () => Worker;
}

// ── Tipos internos ──────────────────────────────────────────────────

interface PoolWorker {
  /** Instancia del Worker thread. */
  worker: Worker;
  /** True si está libre (puede aceptar otra request). */
  idle: boolean;
  /** ID secuencial para round-robin logging. */
  index: number;
}

interface PendingRequest {
  resolve(result: OCRResult): void;
  reject(err: Error): void;
  /** Timer que dispara el timeout. */
  timer: ReturnType<typeof setTimeout> | null;
  /** True si ya se hizo un retry. */
  retried: boolean;
  /** Worker asignado (para retry/metrics). */
  worker: PoolWorker | null;
  /**
   * Copia del buffer para retry. Cuando hacemos `postMessage` con
   * `[ab]`, el ArrayBuffer se transfiere al worker y queda detached
   * en el main thread. Guardamos una copia para poder re-enviar
   * en el retry.
   */
  bufferCopy: Buffer | null;
}

interface IPCResultMessage {
  type: 'result';
  text: string;
  confidence: number;
  tiempoMs: number;
  requestId: string;
}

interface IPCErrorMessage {
  type: 'error';
  message: string;
  requestId: string;
}

// ── Default worker factory ──────────────────────────────────────────

/**
 * Crea un `Worker` que corre `ocrWorker.ts`. Usa `import.meta.url`
 * para resolver el path relativo al archivo.
 */
function defaultWorkerFactory(): Worker {
  const workerPath = fileURLToPath(new URL('./ocrWorker.ts', import.meta.url));
  return new Worker(workerPath);
}

// ── Logger no-op por default ────────────────────────────────────────

function defaultLogger(): Logger {
  const noop = (): undefined => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: defaultLogger,
    level: 'silent',
  } as unknown as Logger;
}

// ── Clase ───────────────────────────────────────────────────────────

/**
 * Pool de workers que ejecutan Tesseract.js. Implementa `OCRExtractor`.
 *
 * Decisión: `extract(buffer)` retorna `OCRResult` con `productos`
 * VACÍO. El parser (`ocrParser.parseOCRText`) se encarga de mapear
 * el texto crudo a productos. Esto separa "qué dijo Tesseract" de
 * "qué producto/cantidad/precio detectamos".
 */
export class TesseractExtractor implements OCRExtractor {
  private readonly pool: PoolWorker[] = [];
  private readonly pending: Map<string, PendingRequest> = new Map();
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly workerFactory: () => Worker;
  private nextWorkerIndex = 0;
  private requestCounter = 0;
  private destroyed = false;

  constructor(opts: TesseractExtractorOptions = {}) {
    this.concurrency = opts.concurrency ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.logger = opts.logger ?? defaultLogger();
    this.workerFactory = opts.workerFactory ?? defaultWorkerFactory;

    if (this.concurrency < 1) {
      throw new Error(`TesseractExtractor: concurrency must be >= 1, got ${this.concurrency}`);
    }
    if (this.timeoutMs < 10) {
      throw new Error(`TesseractExtractor: timeoutMs must be >= 10ms, got ${this.timeoutMs}`);
    }
  }

  /**
   * Inicializa el pool. Lazy: se llama en el primer `extract()` o
   * explícitamente si se quiere pre-warmear.
   */
  private ensurePool(): void {
    if (this.pool.length > 0) return;
    for (let i = 0; i < this.concurrency; i += 1) {
      this.spawnWorker(i);
    }
  }

  private spawnWorker(index: number): PoolWorker {
    const worker = this.workerFactory();
    const poolWorker: PoolWorker = { worker, idle: true, index };
    this.pool.push(poolWorker);

    worker.on('message', (msg: IPCResultMessage | IPCErrorMessage) => {
      void this.handleWorkerMessage(poolWorker, msg);
    });
    worker.on('error', (err) => {
      this.handleWorkerCrash(poolWorker, err);
    });

    this.logger.info(
      { event: 'ocr_worker_spawned', index, total: this.concurrency },
      'tesseract worker spawned',
    );
    return poolWorker;
  }

  private handleWorkerMessage(
    poolWorker: PoolWorker,
    msg: IPCResultMessage | IPCErrorMessage,
  ): void {
    const pending = this.pending.get(msg.requestId);
    if (pending === undefined) return; // stale message, ignore

    if (msg.type === 'error' && !pending.retried) {
      // Retry 1 vez: re-enviar al mismo worker. NO limpiamos el
      // pending del map ni marcamos idle: la request sigue en vuelo.
      pending.retried = true;
      pending.timer = this.startTimeout(pending, msg.requestId);
      this.dispatchToWorker(pending.worker!, msg.requestId);
      return;
    }

    // Éxito o retry agotado. Limpiamos.
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(msg.requestId);
    poolWorker.idle = true;

    if (msg.type === 'error') {
      pending.reject(new OcrFailedError(`OCR failed: ${msg.message}`));
      return;
    }

    // Éxito. Mapeamos a OCRResult.
    const result: OCRResult = {
      productos: [], // el parser se encarga
      textoCompleto: msg.text,
      tiempoMs: msg.tiempoMs,
      confianzaPromedio: msg.confidence,
    };
    pending.resolve(result);
  }

  private handleWorkerCrash(poolWorker: PoolWorker, err: Error): void {
    this.logger.error(
      { event: 'ocr_worker_crash', index: poolWorker.index, err: err.message },
      'tesseract worker crashed',
    );

    // Quitar el worker muerto del pool
    const idx = this.pool.indexOf(poolWorker);
    if (idx >= 0) {
      this.pool.splice(idx, 1);
    }

    // Terminar el worker para liberar recursos
    void poolWorker.worker.terminate().catch(() => undefined);

    // Rechazar cualquier request pendiente asignada a este worker
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.worker === poolWorker) {
        if (pending.timer !== null) clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(new OcrFailedError(`OCR worker crashed: ${err.message}`));
      }
    }

    // Levantar un worker nuevo en su lugar (si no estamos destruidos)
    if (!this.destroyed) {
      this.spawnWorker(poolWorker.index);
    }
  }

  /**
   * Envía un `recognize` request al worker. El buffer se transfiere
   * (no se copia) usando la lista de transferList.
   */
  private dispatchToWorker(poolWorker: PoolWorker, requestId: string): void {
    const pending = this.pending.get(requestId);
    if (pending === undefined || pending.bufferCopy === null) return;
    const buffer = pending.bufferCopy;

    // Slice para crear un ArrayBuffer transferible. `Buffer` está
    // backed por un ArrayBuffer pooled; necesitamos nuestro propio.
    const ab = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(ab).set(buffer);
    poolWorker.worker.postMessage(
      { type: 'recognize', buffer: ab, requestId },
      [ab],
    );
  }

  private startTimeout(pending: PendingRequest, requestId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const stillPending = this.pending.get(requestId);
      if (stillPending === undefined) return;
      this.pending.delete(requestId);
      this.logger.warn(
        { event: 'ocr_timeout', requestId, timeoutMs: this.timeoutMs },
        'tesseract request timed out',
      );
      // Terminar el worker; el crash handler lo va a reemplazar
      if (pending.worker !== null) {
        const idx = this.pool.indexOf(pending.worker);
        if (idx >= 0) {
          this.pool.splice(idx, 1);
        }
        void pending.worker.worker.terminate().catch(() => undefined);
        if (!this.destroyed) {
          this.spawnWorker(pending.worker.index);
        }
      }
      pending.reject(new OcrTimeoutError('OCR took too long', { timeoutMs: this.timeoutMs }));
    }, this.timeoutMs);
  }

  async extract(imageBuffer: Buffer, requestId?: string): Promise<OCRResult> {
    if (this.destroyed) {
      throw new OcrFailedError('TesseractExtractor is destroyed');
    }
    this.ensurePool();

    const reqId = requestId ?? `ocr-${(this.requestCounter += 1)}-${Date.now()}`;

    const poolWorker = this.acquireWorker();
    if (poolWorker === null) {
      throw new OcrFailedError(
        `OCR pool saturated (${this.concurrency} workers busy). Try again later.`,
      );
    }

    return new Promise<OCRResult>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: null,
        retried: false,
        worker: poolWorker,
        bufferCopy: imageBuffer,
      };
      this.pending.set(reqId, pending);
      pending.timer = this.startTimeout(pending, reqId);

      // Slice para crear un ArrayBuffer transferible. `Buffer` está
      // backed por un ArrayBuffer pooled; necesitamos nuestro propio.
      const ab = new ArrayBuffer(imageBuffer.byteLength);
      new Uint8Array(ab).set(imageBuffer);
      poolWorker.worker.postMessage(
        { type: 'recognize', buffer: ab, requestId: reqId },
        [ab],
      );

      this.logger.debug(
        {
          event: 'ocr_started',
          requestId: reqId,
          workerIndex: poolWorker.index,
          bytes: imageBuffer.length,
        },
        'tesseract request dispatched',
      );
    });
  }

  private acquireWorker(): PoolWorker | null {
    // Round-robin: empezamos desde nextWorkerIndex y buscamos el próximo idle
    for (let i = 0; i < this.pool.length; i += 1) {
      const idx = (this.nextWorkerIndex + i) % this.pool.length;
      const pw = this.pool[idx];
      if (pw !== undefined && pw.idle) {
        pw.idle = false;
        this.nextWorkerIndex = (idx + 1) % this.pool.length;
        return pw;
      }
    }
    return null;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    // Rechazar todas las pending
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.reject(new OcrFailedError('TesseractExtractor destroyed'));
      this.pending.delete(requestId);
    }

    // Terminar todos los workers
    await Promise.all(
      this.pool.map(async (pw) => {
        try {
          await pw.worker.terminate();
        } catch (err) {
          this.logger.warn(
            {
              event: 'ocr_worker_terminate_error',
              err: err instanceof Error ? err.message : String(err),
            },
            'failed to terminate worker (continuing)',
          );
        }
      }),
    );
    this.pool.length = 0;
    this.logger.info({ event: 'ocr_pool_destroyed' }, 'tesseract pool destroyed');
  }
}

// ── Re-exports útiles para tests ─────────────────────────────────────
export { defaultWorkerFactory };
export type { PoolWorker, PendingRequest };
