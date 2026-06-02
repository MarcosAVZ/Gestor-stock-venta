/**
 * Tests del use case `validateOCRData`.
 *
 * Cubre:
 * - Happy path: OCR exitoso con producto + precio → prompt correcto
 *   + persistencia en datosTemporales.
 * - OCR sin producto → "no detecté un producto claro".
 * - OCR con Zod parse fallido → "no pude leer bien".
 * - OCR timeout → "la imagen tardó demasiado".
 * - Read del archivo falla → throw OcrFailedError.
 * - producto normalizado (lowercase, trim).
 * - Si el OCR detecta cantidad + unidad, se persisten como sugerencia.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConversacionRepository } from '../../src/domain/repositories/ConversacionRepository.ts';
import { OcrFailedError } from '../../src/domain/errors/OperationalError.ts';
import type { ImagePreprocessor } from '../../src/application/ocr/ExtractPurchaseData.ts';
import type { OCRExtractor } from '../../src/application/ocr/interfaces/OCRExtractor.ts';
import { validateOCRData } from '../../src/application/conversation/ValidateOCRData.ts';

// ── Helpers ─────────────────────────────────────────────────────────

function silentLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => silentLogger(),
    level: 'silent',
  } as unknown as Logger;
}

function buildPreprocessorMock(): ImagePreprocessor {
  return {
    preprocess: vi.fn(async (buf: Buffer) => buf),
  };
}

function buildExtractorMock(opts: { textoCompleto: string; tiempoMs?: number }): OCRExtractor {
  return {
    extract: vi.fn(async () => ({
      productos: [],
      textoCompleto: opts.textoCompleto,
      tiempoMs: opts.tiempoMs ?? 100,
      confianzaPromedio: 0.9,
    })),
    destroy: vi.fn(async () => undefined),
  };
}

function buildConversacionRepoMock(): ConversacionRepository & {
  update: ReturnType<typeof vi.fn>;
} {
  return {
    findByUsuarioId: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(async (_usuarioId: string, patch: { datosTemporales?: Record<string, unknown> }) => ({
      id: 'conv-1',
      usuarioId: _usuarioId,
      estado: 'VALIDANDO_DATOS' as never,
      datosTemporales: patch.datosTemporales ?? {},
      updatedAt: new Date(),
      createdAt: new Date(),
    })),
  } as unknown as ConversacionRepository & { update: ReturnType<typeof vi.fn> };
}

describe('validateOCRData', () => {
  let tmpDir: string;
  let imagePath: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `ocr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
    imagePath = join(tmpDir, 'image.jpg');
    await writeFile(imagePath, Buffer.from('fake-image-bytes'));
  });

  it('happy path: producto + precio → prompt + persist', async () => {
    const conversacionRepo = buildConversacionRepoMock();
    const preprocessor = buildPreprocessorMock();
    const extractor = buildExtractorMock({
      textoCompleto: 'Medias Negras\n$1500\n12 pares',
    });
    const result = await validateOCRData(
      { usuarioId: 'u-1', imagePath, requestId: 'req-1' },
      {
        logger: silentLogger(),
        conversacionRepo,
        preprocessor,
        extractor,
      },
    );

    expect(result.failed).toBe(false);
    expect(result.prompt).toContain('Detecté');
    expect(result.prompt).toContain('medias negras'); // normalizado lowercase
    expect(result.prompt).toContain('¿Es correcto?');
    expect(conversacionRepo.update).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        datosTemporales: expect.objectContaining({
          producto: 'medias negras',
          costoLote: 1500,
        }),
      }),
    );
  });

  it('normaliza el nombre a lowercase + trim', async () => {
    const conversacionRepo = buildConversacionRepoMock();
    const extractor = buildExtractorMock({ textoCompleto: '  MEDIAS NEGRAS  \n$1500' });
    const result = await validateOCRData(
      { usuarioId: 'u-1', imagePath, requestId: 'req-1' },
      {
        logger: silentLogger(),
        conversacionRepo,
        preprocessor: buildPreprocessorMock(),
        extractor,
      },
    );
    expect(result.failed).toBe(false);
    expect(conversacionRepo.update).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        datosTemporales: expect.objectContaining({ producto: 'medias negras' }),
      }),
    );
  });

  it('persiste cantidad + unidad si el OCR los detectó', async () => {
    const conversacionRepo = buildConversacionRepoMock();
    const extractor = buildExtractorMock({ textoCompleto: 'Medias\n$1500\n12 pares' });
    await validateOCRData(
      { usuarioId: 'u-1', imagePath, requestId: 'req-1' },
      {
        logger: silentLogger(),
        conversacionRepo,
        preprocessor: buildPreprocessorMock(),
        extractor,
      },
    );
    expect(conversacionRepo.update).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        datosTemporales: expect.objectContaining({
          cantidadSugerida: 12,
          unidadSugerida: 'PAR',
        }),
      }),
    );
  });

  it('producto sin precio: prompt con mensaje "no pude leer el precio"', async () => {
    // El parser actual no genera productos sin precio (siempre emite
    // precio junto con el producto). Para testear el fallback de
    // "no pude leer el precio", mockeamos el parser para que devuelva
    // un producto con precio null.
    const conversacionRepo = buildConversacionRepoMock();
    const extractor = buildExtractorMock({ textoCompleto: 'Medias Negras' });
    const result = await validateOCRData(
      { usuarioId: 'u-1', imagePath, requestId: 'req-1' },
      {
        logger: silentLogger(),
        conversacionRepo,
        preprocessor: buildPreprocessorMock(),
        extractor,
        // Parser mockeado: devuelve un producto con precio null.
        parser: () => ({
          productos: [{ nombre: 'medias negras', precio: null, cantidad: 1, unidad: 'UNIDAD', confianza: 0.9 }],
          textoCompleto: 'Medias Negras',
          tiempoMs: 100,
          confianzaPromedio: 0.9,
        }),
      },
    );
    expect(result.failed).toBe(false);
    expect(result.prompt).toContain('no pude leer el precio');
  });

  it('OCR sin producto: failed=true', async () => {
    const conversacionRepo = buildConversacionRepoMock();
    const extractor = buildExtractorMock({ textoCompleto: '' });
    const result = await validateOCRData(
      { usuarioId: 'u-1', imagePath, requestId: 'req-1' },
      {
        logger: silentLogger(),
        conversacionRepo,
        preprocessor: buildPreprocessorMock(),
        extractor,
      },
    );
    expect(result.failed).toBe(true);
    expect(result.prompt).toContain('No detecté un producto claro');
  });

  it('OCR timeout: failed=true con mensaje específico', async () => {
    const conversacionRepo = buildConversacionRepoMock();
    // Import dinámico para evitar ciclo.
    const { OcrTimeoutError } = await import('../../src/domain/errors/OperationalError.ts');
    const extractor: OCRExtractor = {
      extract: vi.fn(async () => {
        throw new OcrTimeoutError('timeout', { timeoutMs: 30000 });
      }),
      destroy: vi.fn(async () => undefined),
    };
    const result = await validateOCRData(
      { usuarioId: 'u-1', imagePath, requestId: 'req-1' },
      {
        logger: silentLogger(),
        conversacionRepo,
        preprocessor: buildPreprocessorMock(),
        extractor,
      },
    );
    expect(result.failed).toBe(true);
    expect(result.prompt).toContain('tardó demasiado');
  });

  it('read del archivo falla: throw OcrFailedError', async () => {
    const conversacionRepo = buildConversacionRepoMock();
    const extractor = buildExtractorMock({ textoCompleto: 'x' });
    await expect(
      validateOCRData(
        { usuarioId: 'u-1', imagePath: '/no/existe/path.jpg', requestId: 'req-1' },
        {
          logger: silentLogger(),
          conversacionRepo,
          preprocessor: buildPreprocessorMock(),
          extractor,
        },
      ),
    ).rejects.toThrow(OcrFailedError);
  });

  it('cleanup tmpDir after test', async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });
});
