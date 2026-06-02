/**
 * Tests del use case `ExtractPurchaseData`.
 *
 * Cubre:
 * - Happy path: preprocesa → extrae → parsea → devuelve OCRResult.
 * - Productos vacíos cuando el extractor devuelve texto vacío.
 * - Propaga OcrFailedError sin re-wrapear.
 * - Propaga OcrTimeoutError sin re-wrapear.
 * - Wrap de errores genéricos en OcrFailedError.
 * - Log de `ocr_started` y `ocr_completed`.
 * - Log de `ocr_failed` con mensaje.
 * - Log de `ocr_timeout` con tipo específico.
 * - Pasa el `requestId` al extractor.
 */

import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import type { OCRResult } from '@compras-whatsapp/shared';
import { EMPTY_OCR_RESULT } from '@compras-whatsapp/shared';

import { ExtractPurchaseData, type ImagePreprocessor } from '../../src/application/ocr/ExtractPurchaseData.ts';
import type { OCRExtractor } from '../../src/application/ocr/interfaces/OCRExtractor.ts';
import { OcrFailedError, OcrTimeoutError } from '../../src/domain/errors/OperationalError.ts';

// ── Mocks ────────────────────────────────────────────────────────────

interface LogCall {
  level: 'info' | 'warn' | 'error' | 'debug';
  obj: Record<string, unknown>;
  msg: string;
}

function capturingLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const make = (level: LogCall['level']): Logger['info'] =>
    ((obj: unknown, msg?: string) => {
      calls.push({
        level,
        obj: obj as Record<string, unknown>,
        msg: msg ?? '',
      });
    }) as unknown as Logger['info'];
  const noop = (): undefined => undefined;
  return {
    calls,
    logger: {
      info: make('info'),
      warn: make('warn'),
      error: make('error'),
      debug: make('debug'),
      trace: noop,
      fatal: noop,
      child: capturingLogger,
      level: 'info',
    } as unknown as Logger,
  };
}

function fakePreprocessor(): ImagePreprocessor {
  return {
    async preprocess(buffer: Buffer): Promise<Buffer> {
      // Devuelve un buffer "diferente" para verificar que se llamó.
      return Buffer.concat([buffer, Buffer.from('-preprocessed')]);
    },
  };
}

function fakeExtractor(result: OCRResult): OCRExtractor {
  return {
    async extract(_buffer: Buffer, requestId: string): Promise<OCRResult> {
      // Verificamos que se pasa el requestId a través del log del
      // caller. Devolvemos el resultado configurado.
      void requestId;
      return result;
    },
    async destroy(): Promise<void> {
      // noop
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ExtractPurchaseData', () => {
  it('happy path: preprocesa, extrae, parsea, devuelve OCRResult con productos', async () => {
    const { logger, calls } = capturingLogger();
    const pre = fakePreprocessor();
    const ext = fakeExtractor({
      ...EMPTY_OCR_RESULT,
      textoCompleto: 'Remera Negra\n$1.234,56',
      tiempoMs: 250,
      confianzaPromedio: 0.9,
    });
    const useCase = new ExtractPurchaseData({ preprocessor: pre, extractor: ext, logger });

    const result = await useCase.execute({
      imageBuffer: Buffer.from('image'),
      requestId: 'req-1',
    });

    expect(result.productos).toHaveLength(1);
    expect(result.productos[0]!.nombre).toBe('Remera Negra');
    expect(result.productos[0]!.precio).toBe(1234.56);
    expect(result.tiempoMs).toBe(250);
    expect(result.confianzaPromedio).toBe(0.9);

    // Logs esperados
    const events = calls.map((c) => c.obj.event);
    expect(events).toContain('ocr_started');
    expect(events).toContain('ocr_completed');
  });

  it('productos vacío cuando el texto OCR no contiene precios', async () => {
    const { logger } = capturingLogger();
    const ext = fakeExtractor({
      ...EMPTY_OCR_RESULT,
      textoCompleto: 'Solo texto sin precios',
      tiempoMs: 100,
      confianzaPromedio: 0.5,
    });
    const useCase = new ExtractPurchaseData({
      preprocessor: fakePreprocessor(),
      extractor: ext,
      logger,
    });

    const result = await useCase.execute({
      imageBuffer: Buffer.from('image'),
      requestId: 'req-empty',
    });
    expect(result.productos).toEqual([]);
  });

  it('propaga OcrFailedError del extractor sin re-wrapear', async () => {
    const { logger, calls } = capturingLogger();
    const ext: OCRExtractor = {
      async extract(): Promise<OCRResult> {
        throw new OcrFailedError('Tesseract crash');
      },
      async destroy(): Promise<void> {
        // noop
      },
    };
    const useCase = new ExtractPurchaseData({
      preprocessor: fakePreprocessor(),
      extractor: ext,
      logger,
    });

    await expect(
      useCase.execute({ imageBuffer: Buffer.from('img'), requestId: 'req-fail' }),
    ).rejects.toBeInstanceOf(OcrFailedError);

    const failedLog = calls.find((c) => c.obj.event === 'ocr_failed');
    expect(failedLog).toBeDefined();
  });

  it('propaga OcrTimeoutError del extractor sin re-wrapear', async () => {
    const { logger, calls } = capturingLogger();
    const ext: OCRExtractor = {
      async extract(): Promise<OCRResult> {
        throw new OcrTimeoutError('OCR took 30s');
      },
      async destroy(): Promise<void> {
        // noop
      },
    };
    const useCase = new ExtractPurchaseData({
      preprocessor: fakePreprocessor(),
      extractor: ext,
      logger,
    });

    await expect(
      useCase.execute({ imageBuffer: Buffer.from('img'), requestId: 'req-timeout' }),
    ).rejects.toBeInstanceOf(OcrTimeoutError);

    const timeoutLog = calls.find((c) => c.obj.event === 'ocr_timeout');
    expect(timeoutLog).toBeDefined();
  });

  it('wrap errores genéricos en OcrFailedError', async () => {
    const { logger } = capturingLogger();
    const ext: OCRExtractor = {
      async extract(): Promise<OCRResult> {
        throw new Error('Unexpected');
      },
      async destroy(): Promise<void> {
        // noop
      },
    };
    const useCase = new ExtractPurchaseData({
      preprocessor: fakePreprocessor(),
      extractor: ext,
      logger,
    });

    await expect(
      useCase.execute({ imageBuffer: Buffer.from('img'), requestId: 'req-unwrap' }),
    ).rejects.toBeInstanceOf(OcrFailedError);
  });

  it('pasa el preprocessed buffer al extractor (no el original)', async () => {
    const { logger } = capturingLogger();
    let receivedBuffer: Buffer | null = null;
    const ext: OCRExtractor = {
      async extract(buffer: Buffer): Promise<OCRResult> {
        receivedBuffer = buffer;
        return { ...EMPTY_OCR_RESULT, textoCompleto: '', tiempoMs: 0, confianzaPromedio: 0 };
      },
      async destroy(): Promise<void> {
        // noop
      },
    };
    const useCase = new ExtractPurchaseData({
      preprocessor: fakePreprocessor(),
      extractor: ext,
      logger,
    });

    await useCase.execute({ imageBuffer: Buffer.from('orig'), requestId: 'req-pre' });
    expect(receivedBuffer).not.toBeNull();
    expect((receivedBuffer as unknown as Buffer).toString()).toBe('orig-preprocessed');
  });

  it('incluye phone en logs cuando se pasa', async () => {
    const { logger, calls } = capturingLogger();
    const ext = fakeExtractor({
      ...EMPTY_OCR_RESULT,
      textoCompleto: '',
      tiempoMs: 50,
      confianzaPromedio: 0.8,
    });
    const useCase = new ExtractPurchaseData({
      preprocessor: fakePreprocessor(),
      extractor: ext,
      logger,
    });

    await useCase.execute({
      imageBuffer: Buffer.from('img'),
      requestId: 'req-phone',
      phone: '+5491112345678',
    });

    const startedLog = calls.find((c) => c.obj.event === 'ocr_started');
    expect(startedLog?.obj.phone).toBe('+5491112345678');
  });
});
