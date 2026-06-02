/**
 * Tests del LocalImageStorage.
 *
 * Cubre:
 * - save() crea el directorio y persiste el buffer.
 * - save() genera nombres únicos (no colisionan entre calls).
 * - save() rechaza buffers vacíos.
 * - getPath() valida anti path traversal.
 * - sanitizePhone rechaza phone vacío después de sanear.
 * - cleanup() borra archivos más viejos que N días.
 * - cleanup() ignora archivos más nuevos.
 * - cleanup() cuenta correctamente.
 * - createReadStreamFor() funciona para archivos existentes.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalImageStorage } from '../../src/infrastructure/storage/LocalImageStorage.ts';

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

describe('LocalImageStorage', () => {
  let rootDir: string;
  let storage: LocalImageStorage;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'img-storage-'));
    storage = new LocalImageStorage({ rootPath: rootDir, logger: silentLogger() });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  describe('save()', () => {
    it('persiste el buffer y devuelve el path', async () => {
      const buffer = Buffer.from('fake-image-bytes');
      const path = await storage.save('+5491112345678', buffer, 'jpg');
      expect(path).toContain('+5491112345678');
      expect(path).toMatch(/\.jpg$/);

      // Verificar que el archivo existe leyendo el directorio
      const files = await readdir(join(rootDir, '+5491112345678'));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.jpg$/);
    });

    it('genera nombres únicos entre calls (no colisionan)', async () => {
      const path1 = await storage.save('+5491111111111', Buffer.from('a'), 'png');
      // Esperar 2ms para asegurar timestamp distinto
      await new Promise((r) => setTimeout(r, 5));
      const path2 = await storage.save('+5491111111111', Buffer.from('b'), 'png');
      expect(path1).not.toBe(path2);
    });

    it('rechaza buffer vacío', async () => {
      await expect(storage.save('+54911', Buffer.alloc(0), 'jpg')).rejects.toThrow(/empty/);
    });

    it('rechaza phone que queda vacío después de sanear', async () => {
      await expect(storage.save('---', Buffer.from('x'), 'jpg')).rejects.toThrow(/invalid phone/);
    });

    it('sanea phone con caracteres no permitidos', async () => {
      const path = await storage.save('+54 9 11 1234-5678', Buffer.from('x'), 'jpg');
      // Los chars no permitidos se descartan
      expect(path).toContain('+5491112345678');
    });

    it('usa jpg como extensión default si no se pasa', async () => {
      const path = await storage.save('+54911', Buffer.from('x'));
      expect(path).toMatch(/\.jpg$/);
    });

    it('fuerza jpg si la extensión no está permitida', async () => {
      const path = await storage.save('+54911', Buffer.from('x'), 'exe');
      expect(path).toMatch(/\.jpg$/);
    });

    it('crea el subdirectorio del phone si no existe', async () => {
      await storage.save('+5491188887777', Buffer.from('y'), 'webp');
      const dirs = await readdir(rootDir);
      expect(dirs).toContain('+5491188887777');
    });
  });

  describe('getPath()', () => {
    it('rechaza filename con path traversal', () => {
      expect(() => storage.getPath('+54911', '../etc/passwd')).toThrow(/invalid filename/);
    });

    it('rechaza filename con separador', () => {
      expect(() => storage.getPath('+54911', 'sub/file.jpg')).toThrow(/invalid filename/);
    });

    it('devuelve path dentro del root para input válido', () => {
      const path = storage.getPath('+54911', '1700000000-abcd.jpg');
      expect(path.startsWith(rootDir)).toBe(true);
    });
  });

  describe('cleanup()', () => {
    it('borra archivos más viejos que N días', async () => {
      // Guardar un archivo "viejo" con mtime manipulado
      const path = await storage.save('+54911', Buffer.from('old'), 'jpg');

      // Manipular mtime a 10 días atrás
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const { utimes } = await import('node:fs/promises');
      await utimes(path, oldDate, oldDate);

      const deleted = await storage.cleanup(7);
      expect(deleted).toBe(1);

      const files = await readdir(join(rootDir, '+54911'));
      expect(files).toHaveLength(0);
    });

    it('NO borra archivos más nuevos que N días', async () => {
      await storage.save('+54911', Buffer.from('fresh'), 'jpg');
      const deleted = await storage.cleanup(7);
      expect(deleted).toBe(0);

      const files = await readdir(join(rootDir, '+54911'));
      expect(files).toHaveLength(1);
    });

    it('cuenta correctamente múltiples archivos', async () => {
      const path1 = await storage.save('+54911', Buffer.from('1'), 'jpg');
      const path2 = await storage.save('+54911', Buffer.from('2'), 'jpg');
      await storage.save('+54911', Buffer.from('fresh'), 'jpg');

      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const { utimes } = await import('node:fs/promises');
      await utimes(path1, oldDate, oldDate);
      await utimes(path2, oldDate, oldDate);

      const deleted = await storage.cleanup(7);
      expect(deleted).toBe(2);
    });

    it('rechaza olderThanDays negativo', async () => {
      await expect(storage.cleanup(-1)).rejects.toThrow(/olderThanDays/);
    });
  });

  describe('createReadStreamFor()', () => {
    it('abre un read stream para un archivo existente', async () => {
      const expected = Buffer.from('stream-me');
      await storage.save('+54911', expected, 'jpg');

      const files = await readdir(join(rootDir, '+54911'));
      const filename = files[0]!;

      const stream = storage.createReadStreamFor('+54911', filename);
      const collected: Buffer[] = [];
      await pipeline(stream, async function* (source) {
        for await (const chunk of source as Readable) {
          collected.push(chunk as Buffer);
        }
      });

      expect(Buffer.concat(collected).toString()).toBe('stream-me');
    });
  });
});
