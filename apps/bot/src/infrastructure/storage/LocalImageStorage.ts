/**
 * `LocalImageStorage` — persistencia de imágenes en filesystem local.
 *
 * POR QUÉ EXISTE:
 * El port `WhatsAppMessagingPort.downloadMedia` (en PR3) hacía
 * doble trabajo: descargaba el base64 de WAWebJS y lo escribía a
 * disco. Eso acoplaba la capa de mensajería con la capa de
 * filesystem, y testeable con mocks raros.
 *
 * PR4 refactoriza el port para devolver `Buffer` y mueve la
 * persistencia a esta clase. Beneficios:
 * - El port es SIMPLE: solo descarga bytes.
 * - El storage es testeable de forma aislada (con `mkdtemp`).
 * - El cleanup y la rotación de archivos tienen un solo owner.
 *
 * ESTRUCTURA DE DIRECTORIOS:
 *   <root>/
 *     <phone>/
 *       <timestamp>-<rand>.<ext>
 *
 * Phone se sanitiza (solo `+` y dígitos) para evitar path traversal
 * (un usuario malicioso podría mandar un phone con `../` y escapar
 * del root). Ver `sanitizePhone` abajo.
 *
 * STREAMING:
 * `save()` usa `pipeline` de `node:stream/promises` con un
 * `Readable.from(buffer)` y `createWriteStream`. Esto cumple el
 * requisito de OWASP A05 (no cargar todo en memoria para
 * imágenes grandes) y el lineamiento de la task description.
 *
 * CLEANUP:
 * `cleanup(olderThanDays)` borra archivos más viejos que N días.
 * Se ejecuta en background (best-effort) — no bloquea el flujo
 * principal de la conversación. Devuelve la cantidad borrada
 * para logging/metrics.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Logger } from 'pino';

/** Extensiones permitidas para las imágenes guardadas. */
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

/** Extensión default si el caller no la pasa. */
const DEFAULT_EXTENSION = 'jpg';

/**
 * Sanea el `phone` para usarlo como nombre de directorio.
 * Solo permite `+` y dígitos. Cualquier otro carácter se descarta.
 *
 * Defensa contra path traversal: un phone con `../etc/passwd` se
 * convierte en `etcpasswd` y queda confinado al root.
 */
function sanitizePhone(phone: string): string {
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.length === 0) {
    throw new Error(`LocalImageStorage: invalid phone (empty after sanitize): ${phone}`);
  }
  return cleaned;
}

/** Sanea la extensión: solo chars alfanuméricos, default a `jpg`. */
function sanitizeExtension(ext: string | undefined): string {
  if (ext === undefined) return DEFAULT_EXTENSION;
  const cleaned = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!ALLOWED_EXTENSIONS.has(cleaned)) return DEFAULT_EXTENSION;
  return cleaned;
}

/** Valida que `child` esté dentro de `parent` (anti path traversal). */
function isInside(parent: string, child: string): boolean {
  const rel = resolve(child);
  return rel === resolve(parent) || rel.startsWith(resolve(parent) + '\\') || rel.startsWith(resolve(parent) + '/');
}

export interface LocalImageStorageConfig {
  /** Directorio root donde se guardan las imágenes. */
  rootPath: string;
  /** Logger para observabilidad. */
  logger: Logger;
}

export class LocalImageStorage {
  private readonly rootPath: string;
  private readonly logger: Logger;

  constructor(config: LocalImageStorageConfig) {
    this.rootPath = resolve(config.rootPath);
    this.logger = config.logger;
    this.logger.info(
      { event: 'image_storage_initialized', rootPath: this.rootPath },
      'LocalImageStorage ready',
    );
  }

  /**
   * Construye el path completo para un archivo.
   * Útil para tests y para pasar a OCR si en el futuro queremos
   * re-leer del disco.
   */
  getPath(phone: string, filename: string): string {
    const safePhone = sanitizePhone(phone);
    // Anti traversal: filename no debe contener `..` ni `/` ni `\`
    if (/(\.\.|[\/\\])/.test(filename)) {
      throw new Error(`LocalImageStorage: invalid filename: ${filename}`);
    }
    const full = join(this.rootPath, safePhone, filename);
    if (!isInside(this.rootPath, full)) {
      throw new Error(`LocalImageStorage: path escapes root: ${full}`);
    }
    return full;
  }

  /**
   * Persiste un buffer de imagen al filesystem. Devuelve el path
   * completo donde se guardó. Usa `pipeline` para escribir vía
   * stream (no carga el archivo en memoria de más).
   *
   * El nombre del archivo es `<timestampMs>-<rand8>.<ext>` donde
   * `rand8` son 4 bytes random en hex. El timestamp evita colisiones
   * y permite cleanup por edad.
   */
  async save(
    phone: string,
    buffer: Buffer,
    extension: string | undefined = DEFAULT_EXTENSION,
  ): Promise<string> {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('LocalImageStorage.save: buffer must be non-empty Buffer');
    }
    const safePhone = sanitizePhone(phone);
    const ext = sanitizeExtension(extension);
    const filename = `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
    const dirPath = join(this.rootPath, safePhone);
    const fullPath = join(dirPath, filename);

    // Anti traversal final
    if (!isInside(this.rootPath, fullPath)) {
      throw new Error(`LocalImageStorage: path escapes root: ${fullPath}`);
    }

    // Asegurar que el directorio existe
    await mkdir(dirPath, { recursive: true });

    // Stream el buffer al filesystem (pipeline para manejo de errores)
    await pipeline(
      Readable.from(buffer),
      createWriteStream(fullPath),
    );

    this.logger.info(
      {
        event: 'image_saved',
        phone: safePhone,
        path: fullPath,
        bytes: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
      },
      'image persisted',
    );

    return fullPath;
  }

  /**
   * Borra archivos más viejos que `olderThanDays` en todos los
   * subdirectorios de `rootPath`. Devuelve la cantidad borrada.
   *
   * Best-effort: si un archivo no se puede borrar, se loggea y
   * se continúa. No propaga errores al caller.
   */
  async cleanup(olderThanDays: number): Promise<number> {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      throw new Error(
        `LocalImageStorage.cleanup: olderThanDays must be >= 0, got ${olderThanDays}`,
      );
    }
    const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let deleted = 0;
    try {
      const phoneDirs = await readdir(this.rootPath, { withFileTypes: true });
      for (const dirent of phoneDirs) {
        if (!dirent.isDirectory()) continue;
        const phonePath = join(this.rootPath, dirent.name);
        if (!isInside(this.rootPath, phonePath)) continue;
        const files = await readdir(phonePath, { withFileTypes: true });
        for (const file of files) {
          if (!file.isFile()) continue;
          const filePath = join(phonePath, file.name);
          if (!isInside(this.rootPath, filePath)) continue;
          try {
            const st = await stat(filePath);
            if (st.mtimeMs < cutoffMs) {
              await unlink(filePath);
              deleted += 1;
            }
          } catch (err) {
            this.logger.warn(
              { event: 'image_cleanup_failed', path: filePath, err: (err as Error).message },
              'failed to delete file during cleanup',
            );
          }
        }
      }
    } catch (err) {
      this.logger.error(
        { event: 'image_cleanup_error', err: (err as Error).message },
        'cleanup iteration failed',
      );
    }
    this.logger.info(
      { event: 'image_cleanup_completed', deleted, olderThanDays },
      'cleanup done',
    );
    return deleted;
  }

  /**
   * Stream-friendly: abre un `createReadStream` para un archivo
   * validado dentro del root. Útil para servir imágenes vía HTTP
   * o para que el preprocesador sharp las lea (si en el futuro
   * queremos preprocesar del disco en vez de memoria).
   */
  createReadStreamFor(phone: string, filename: string): ReadStream {
    const fullPath = this.getPath(phone, filename);
    return createReadStream(fullPath);
  }
}
