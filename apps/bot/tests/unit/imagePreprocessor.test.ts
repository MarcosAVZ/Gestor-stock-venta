/**
 * Tests del imagePreprocessor.
 *
 * El pre-procesador usa `sharp`, que requiere bindings nativos (libvips).
 * En Windows con Node 22 funciona out-of-the-box via prebuilds.
 * Si en algún host la instalación falla, sharp tira al require y los
 * tests fallan con un mensaje claro — no se skipean silenciosamente
 * porque el módulo no es opcional.
 *
 * Cubre:
 * - preprocess() con una imagen sintética (PNG blanco) → output
 *   es PNG buffer válido, dimensiones menores o iguales a 100x100.
 * - preprocess() con imagen de 2000x2000 → resize a 1280 max ancho.
 * - preprocess() tira si el path no existe.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_WIDTH_PX,
  preprocess,
  SHARPEN_SIGMA,
  THRESHOLD_VALUE,
} from '../../src/infrastructure/ocr/imagePreprocessor.ts';

describe('imagePreprocessor', () => {
  let tmpDir: string;
  let fixturePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'ocr-preproc-'));
    // Creamos una imagen sintética 100x100 blanca con algo de ruido
    // (canal alpha con grises) para que `normalise` haga algo visible.
    const buf = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 240, g: 240, b: 240, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    fixturePath = join(tmpDir, 'fixture.png');
    await writeFile(fixturePath, buf);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('exports the pipeline constants', () => {
    expect(MAX_WIDTH_PX).toBe(1280);
    expect(SHARPEN_SIGMA).toBe(1);
    expect(THRESHOLD_VALUE).toBe(150);
  });

  it('preprocess() returns a non-empty Buffer', async () => {
    const result = await preprocess(fixturePath);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('preprocess() output is a valid PNG', async () => {
    const result = await preprocess(fixturePath);
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    expect(result[0]).toBe(0x89);
    expect(result[1]).toBe(0x50);
    expect(result[2]).toBe(0x4e);
    expect(result[3]).toBe(0x47);
  });

  it('preprocess() resizes images larger than 1280px to fit', async () => {
    // Crear imagen grande 2000x2000
    const bigPath = join(tmpDir, 'big.png');
    const bigBuf = await sharp({
      create: { width: 2000, height: 2000, channels: 4, background: 'white' },
    })
      .png()
      .toBuffer();
    await writeFile(bigPath, bigBuf);

    const result = await preprocess(bigPath);
    const meta = await sharp(result).metadata();
    expect(meta.width).toBeLessThanOrEqual(MAX_WIDTH_PX);
    // aspect ratio preservado → alto también <= 1280
    expect(meta.height).toBeLessThanOrEqual(MAX_WIDTH_PX);
  });

  it('preprocess() converts to grayscale (R=G=B for all pixels)', async () => {
    const result = await preprocess(fixturePath);
    // Leemos los pixeles raw con sharp y verificamos que R==G==B
    // (la conversión a grayscale los iguala) Y que son 0 o 255
    // (threshold binario). Esta validación es robusta a que sharp
    // mantenga el layout RGBA en el buffer.
    const { data, info } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBeGreaterThanOrEqual(1);
    // Verificamos al menos 10 pixeles para tener coverage razonable
    const sampleSize = Math.min(100, info.width * info.height);
    for (let i = 0; i < sampleSize; i += 1) {
      const offset = i * info.channels;
      const r = data[offset] ?? 0;
      const g = data[offset + 1] ?? r;
      const b = data[offset + 2] ?? r;
      // R == G == B (grayscale)
      expect(r).toBe(g);
      expect(g).toBe(b);
      // Valor binario (0 = negro, 255 = blanco)
      expect([0, 255]).toContain(r);
    }
  });

  it('preprocess() throws when the path does not exist', async () => {
    await expect(preprocess(join(tmpDir, 'no-existe.jpg'))).rejects.toThrow();
  });

  it('preprocess() persists a valid file when written back to disk', async () => {
    // Test adicional: el buffer se puede re-leer con sharp sin errores
    // (defensa contra un output corrupto).
    const result = await preprocess(fixturePath);
    const outPath = join(tmpDir, 'out.png');
    await writeFile(outPath, result);
    const written = await readFile(outPath);
    expect(written.length).toBe(result.length);
    const meta = await sharp(written).metadata();
    expect(meta.format).toBe('png');
  });
});
