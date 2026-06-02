/**
 * @compras-whatsapp/bot — safeLogger (logger no-op para use desde workers).
 *
 * POR QUÉ EXISTE: `tesseract.js` corre en `node:worker_threads`. Los
 * workers NO comparten el logger Pino del main thread por default.
 * Si importamos `pino` acá, duplicamos instancias y rompemos el
 * correlation id (`requestId`) que el main thread setea.
 *
 * Solución: cuando un worker necesita loggear (errores de Tesseract,
 * crashes), usa un logger no-op local. El main thread loggea el
 * resultado del worker (success o error) con el contexto completo.
 *
 * Este helper también se usa en el dispatcher (`eventDispatcher.ts`)
 * como safety net cuando el port no expone un logger.
 */

import type { Logger } from 'pino';

/**
 * Retorna un logger Pino-shaped que no hace nada. Compatible con la
 * interface de Pino, así cualquier `logger.info({...}, 'msg')` se
 * descarta sin error.
 */
export function safeLogger(): Logger {
  const noop = (): undefined => undefined;
  const child = (): Logger => safeLogger();
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child,
    level: 'silent',
  } as unknown as Logger;
}
