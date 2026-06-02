/**
 * Tests del TesseractExtractor (pool de worker_threads).
 *
 * Estos tests NO levantan Tesseract real (WASM pesado, no viable en CI).
 * En su lugar inyectamos un `workerFactory` que retorna un fake `Worker`
 * con la misma API (postMessage, on, terminate). El fake captura los
 * mensajes enviados y permite simular respuestas del worker.
 *
 * Cubre:
 * - Pool se inicializa lazy (en el primer extract).
 * - Pool levanta N workers según concurrency.
 * - Pool saturado: lanza OcrFailedError.
 * - Worker responde con 'result' → resuelve con OCRResult correcto.
 * - Worker responde con 'error' → retry 1 vez; si vuelve a fallar, OcrFailedError.
 * - Worker tarda más de timeoutMs → OcrTimeoutError.
 * - Worker crashea (event 'error') → request falla con OcrFailedError y se levanta worker nuevo.
 * - destroy() termina todos los workers y rechaza pending requests.
 * - Constructor valida concurrency >= 1 y timeoutMs >= 1000.
 */

import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TesseractExtractor } from '../../src/infrastructure/ocr/TesseractExtractor.ts';
import { OcrFailedError, OcrTimeoutError } from '../../src/domain/errors/OperationalError.ts';

// ── Fake Worker ──────────────────────────────────────────────────────

type FakeWorkerListener<E extends string> = E extends 'message'
  ? (msg: unknown) => void
  : E extends 'error'
  ? (err: Error) => void
  : (...args: unknown[]) => void;

interface FakeWorker {
  postMessage: (msg: unknown, transfer?: unknown[]) => void;
  terminate: () => Promise<void>;
  on<E extends 'message' | 'error'>(event: E, listener: FakeWorkerListener<E>): FakeWorkerInternal;
  emit(event: 'message' | 'error', ...args: unknown[]): boolean;
}

interface FakeWorkerInternal extends FakeWorker {
  __postMessageCalls: Array<{ msg: unknown }>;
  __emitter: EventEmitter;
  __simulateResult(text: string, confidence: number, tiempoMs: number, requestId: string): void;
  __simulateError(message: string, requestId: string): void;
  __simulateCrash(err: Error): void;
}

function makeFakeWorker(): FakeWorkerInternal {
  const emitter = new EventEmitter();
  const postMessageCalls: Array<{ msg: unknown }> = [];
  const fake: FakeWorkerInternal = {
    postMessage: (msg: unknown) => {
      postMessageCalls.push({ msg });
    },
    terminate: async () => undefined,
    on: ((event: 'message' | 'error', listener: FakeWorkerListener<'message' | 'error'>) => {
      emitter.on(event, listener as (...a: unknown[]) => void);
      return fake;
    }) as FakeWorker['on'],
    emit: emitter.emit.bind(emitter) as FakeWorker['emit'],
    __postMessageCalls: postMessageCalls,
    __emitter: emitter,
    __simulateResult(text, confidence, tiempoMs, requestId) {
      emitter.emit('message', { type: 'result', text, confidence, tiempoMs, requestId });
    },
    __simulateError(message, requestId) {
      emitter.emit('message', { type: 'error', message, requestId });
    },
    __simulateCrash(err) {
      emitter.emit('error', err);
    },
  };
  return fake;
}

// ── Logger silencioso ────────────────────────────────────────────────

function silentLogger(): Logger {
  const noop = (): undefined => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: silentLogger,
    level: 'silent',
  } as unknown as Logger;
}

// ── Test setup ──────────────────────────────────────────────────────

interface ExtractorTestRig {
  extractor: TesseractExtractor;
  /** Workers ya spawneados por el extractor (después de ensurePool). */
  spawnedWorkers: FakeWorkerInternal[];
  /** Crea un fake worker extra (para reemplazos después de crash). */
  createExtraWorker(): FakeWorkerInternal;
  /**
   * Espera a que `ensurePool()` haya spawneado N workers.
   * Se usa después de la primera llamada a `extract()`.
   */
  waitForPool(expectedCount: number): Promise<void>;
}

async function buildRig(opts: {
  concurrency?: number;
  timeoutMs?: number;
  initialWorkers?: number;
  logger?: Logger;
}): Promise<ExtractorTestRig> {
  const initial = opts.initialWorkers ?? opts.concurrency ?? 2;
  const preallocated: FakeWorkerInternal[] = [];
  for (let i = 0; i < initial; i += 1) {
    preallocated.push(makeFakeWorker());
  }
  let idx = 0;

  const spawned: FakeWorkerInternal[] = [];
  const factory = (): Worker => {
    // Primero consumir preallocated. Si se acaban, crear nuevos
    // (para reemplazos después de crash, etc.).
    let w: FakeWorkerInternal;
    if (idx < preallocated.length) {
      w = preallocated[idx]!;
    } else {
      w = makeFakeWorker();
    }
    idx += 1;
    spawned.push(w);
    return w as unknown as Worker;
  };

  const extractor = new TesseractExtractor({
    concurrency: opts.concurrency,
    timeoutMs: opts.timeoutMs,
    workerFactory: factory,
    logger: opts.logger,
  });

  return {
    extractor,
    get spawnedWorkers() {
      return spawned;
    },
    createExtraWorker() {
      return makeFakeWorker();
    },
    async waitForPool(expectedCount) {
      // El spawn es síncrono dentro de `extract()`. Un par de
      // microtasks alcanza.
      for (let i = 0; i < 10; i += 1) {
        if (spawned.length >= expectedCount) return;
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('TesseractExtractor', () => {
  let rig: ExtractorTestRig;

  beforeEach(() => {
    rig = undefined as unknown as ExtractorTestRig;
  });

  afterEach(async () => {
    if (rig) {
      try {
        await rig.extractor.destroy();
      } catch {
        // ignore
      }
    }
  });

  describe('constructor validation', () => {
    it('throws if concurrency < 1', () => {
      const w = makeFakeWorker();
      expect(
        () =>
          new TesseractExtractor({
            concurrency: 0,
            workerFactory: () => w as unknown as Worker,
          }),
      ).toThrow(/concurrency/);
    });

    it('throws if timeoutMs < 10', () => {
      const w = makeFakeWorker();
      expect(
        () =>
          new TesseractExtractor({
            workerFactory: () => w as unknown as Worker,
            concurrency: 1,
            timeoutMs: 5,
            logger: silentLogger(),
          }),
      ).toThrow(/timeoutMs/);
    });
  });

  describe('pool initialization', () => {
    it('spawns N workers on first extract (lazy)', async () => {
      rig = await buildRig({ concurrency: 2, timeoutMs: 5000 });
      const promise = rig.extractor.extract(Buffer.from('test'), 'req-1');
      await rig.waitForPool(2);

      // El primer worker (round-robin) recibe el request
      const worker = rig.spawnedWorkers[0]!;
      worker.__simulateResult('hola mundo', 0.95, 100, 'req-1');

      const result = await promise;
      expect(result.textoCompleto).toBe('hola mundo');
      expect(result.confianzaPromedio).toBe(0.95);
      expect(result.tiempoMs).toBe(100);
      expect(result.productos).toEqual([]);
    });

    it('uses 2 workers by default', async () => {
      rig = await buildRig({ timeoutMs: 5000 });
      const p1 = rig.extractor.extract(Buffer.from('a'), 'req-a');
      await rig.waitForPool(2);
      const p2 = rig.extractor.extract(Buffer.from('b'), 'req-b');
      await Promise.resolve();

      // Cada worker recibió 1 request
      expect(rig.spawnedWorkers[0]!.__postMessageCalls.length).toBe(1);
      expect(rig.spawnedWorkers[1]!.__postMessageCalls.length).toBe(1);

      rig.spawnedWorkers[0]!.__simulateResult('a', 0.9, 50, 'req-a');
      rig.spawnedWorkers[1]!.__simulateResult('b', 0.9, 60, 'req-b');

      const r1 = await p1;
      const r2 = await p2;
      expect(r1.textoCompleto).toBe('a');
      expect(r2.textoCompleto).toBe('b');
    });
  });

  describe('pool saturation', () => {
    it('throws OcrFailedError if all workers are busy', async () => {
      rig = await buildRig({ concurrency: 2, timeoutMs: 60_000 });

      // Tomar los 2 workers
      const p1 = rig.extractor.extract(Buffer.from('a'), 'req-1');
      await rig.waitForPool(2);
      const p2 = rig.extractor.extract(Buffer.from('b'), 'req-2');
      await Promise.resolve();

      // Tercer request: pool saturado → throw inmediato
      await expect(rig.extractor.extract(Buffer.from('c'), 'req-3')).rejects.toBeInstanceOf(
        OcrFailedError,
      );

      // Limpiamos
      rig.spawnedWorkers[0]!.__simulateResult('a', 0.9, 50, 'req-1');
      rig.spawnedWorkers[1]!.__simulateResult('b', 0.9, 60, 'req-2');
      await p1;
      await p2;
    });
  });

  describe('error handling', () => {
    it('retries once on worker error, then throws OcrFailedError', async () => {
      rig = await buildRig({ concurrency: 1, timeoutMs: 60_000 });

      const promise = rig.extractor.extract(Buffer.from('x'), 'req-retry');
      await rig.waitForPool(1);

      const worker = rig.spawnedWorkers[0]!;
      // 1er error → retry
      worker.__simulateError('tesseract crashed', 'req-retry');
      await Promise.resolve();
      await Promise.resolve();

      // 2do error → fail definitivo
      worker.__simulateError('still broken', 'req-retry');

      await expect(promise).rejects.toBeInstanceOf(OcrFailedError);
      expect(worker.__postMessageCalls.length).toBe(2);
    });
  });

  describe('timeout', () => {
    it('throws OcrTimeoutError if worker does not respond in time', async () => {
      rig = await buildRig({ concurrency: 1, timeoutMs: 50, logger: silentLogger() });

      // No simulamos respuesta → debe disparar timeout
      const promise = rig.extractor.extract(Buffer.from('slow'), 'req-timeout');

      await expect(promise).rejects.toBeInstanceOf(OcrTimeoutError);
    });
  });

  describe('worker crash', () => {
    it('rejects pending request and spawns replacement worker', async () => {
      rig = await buildRig({ concurrency: 2, timeoutMs: 60_000 });

      const promise = rig.extractor.extract(Buffer.from('crash'), 'req-crash');
      await rig.waitForPool(2);

      // Simulamos crash del primer worker
      const worker = rig.spawnedWorkers[0]!;
      worker.__simulateCrash(new Error('boom'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // El request que estaba en este worker debe fallar
      await expect(promise).rejects.toBeInstanceOf(OcrFailedError);

      // El extractor levanta un worker de reemplazo (3ro)
      expect(rig.spawnedWorkers.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('destroy()', () => {
    it('rejects all pending requests', async () => {
      rig = await buildRig({ concurrency: 2, timeoutMs: 60_000 });

      const p1 = rig.extractor.extract(Buffer.from('a'), 'req-a');
      await rig.waitForPool(2);
      const p2 = rig.extractor.extract(Buffer.from('b'), 'req-b');
      await Promise.resolve();

      await rig.extractor.destroy();

      await expect(p1).rejects.toBeInstanceOf(OcrFailedError);
      await expect(p2).rejects.toBeInstanceOf(OcrFailedError);
    });

    it('is idempotent', async () => {
      rig = await buildRig({ timeoutMs: 5000 });
      await rig.extractor.destroy();
      await rig.extractor.destroy(); // no debe throw
    });

    it('rejects subsequent extracts after destroy', async () => {
      rig = await buildRig({ timeoutMs: 5000 });
      await rig.extractor.destroy();
      await expect(rig.extractor.extract(Buffer.from('x'))).rejects.toBeInstanceOf(OcrFailedError);
    });
  });
});
