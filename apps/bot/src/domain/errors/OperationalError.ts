/**
 * OperationalError — base para errores recuperables (4xx).
 *
 * Se lanza cuando el sistema recibe input inválido del exterior, el
 * usuario no está autorizado, un recurso no existe, o se agotó una
 * cuota. El caller puede responder con un mensaje contextual y seguir
 * funcionando: NO es un bug.
 *
 * Subclases concretas en este archivo: NotFoundError, ValidationError,
 * UnauthorizedError, RateLimitError. Cada una con un `code` estable
 * y metadata opcional.
 */

import { AppError, type AppErrorMetadata } from './AppError.ts';

export class OperationalError extends AppError {
  constructor(
    code: string,
    message: string,
    options: { cause?: unknown; metadata?: AppErrorMetadata } = {},
  ) {
    super(code, message, { isOperational: true, ...options });
  }
}

/**
 * Recurso no encontrado (id inexistente, fila borrada, etc.).
 * code: `not_found`
 */
export class NotFoundError extends OperationalError {
  constructor(resource: string, idOrCriteria: string, options: { cause?: unknown } = {}) {
    super('not_found', `${resource} not found: ${idOrCriteria}`, {
      ...options,
      metadata: { resource, criteria: idOrCriteria },
    });
  }
}

/**
 * Input del usuario no cumple las reglas de validación (Zod, regex,
 * parser, etc.). code: `validation_error`.
 */
export class ValidationError extends OperationalError {
  constructor(
    message: string,
    options: { cause?: unknown; field?: string; metadata?: AppErrorMetadata } = {},
  ) {
    super('validation_error', message, {
      ...options,
      metadata: { ...(options.metadata ?? {}), field: options.field },
    });
  }
}

/**
 * Usuario no autorizado (fuera de whitelist, token inválido, etc.).
 * code: `unauthorized`.
 *
 * ⚠️ Por convención (OWASP A01 + A09), el `message` NO debe filtrar
 * qué whitelist falló ni el número que llegó. Siempre "No autorizado."
 * genérico. El id real queda solo en `metadata` para logging interno.
 */
export class UnauthorizedError extends OperationalError {
  constructor(options: { cause?: unknown; metadata?: AppErrorMetadata } = {}) {
    super('unauthorized', 'No autorizado.', options);
  }
}

/**
 * Rate limit disparado. code: `rate_limit`. `retryAfterSec` opcional
 * para que el caller sepa cuántos segundos esperar antes de reintentar.
 */
export class RateLimitError extends OperationalError {
  constructor(
    message: string,
    options: { retryAfterSec?: number; cause?: unknown; metadata?: AppErrorMetadata } = {},
  ) {
    super('rate_limit', message, {
      ...options,
      metadata: { ...(options.metadata ?? {}), retryAfterSec: options.retryAfterSec },
    });
  }
}

/**
 * OCR falló (timeout, parse error, confianza < threshold, etc.).
 * code: `ocr_failed`. Es operacional porque el caller puede responder
 * con "no pude leer la imagen, ¿la reenviás?" y seguir funcionando.
 *
 * Subclases provistas:
 * - `OcrTimeoutError`: el worker tardó más de `timeoutMs` (default 30s).
 *   Se `worker.terminate()` y se re-lanza con este error.
 */
export class OcrFailedError extends OperationalError {
  constructor(
    message: string,
    options: { cause?: unknown; metadata?: AppErrorMetadata } = {},
  ) {
    super('ocr_failed', message, options);
  }
}

/**
 * El OCR tardó más que el timeout configurado. Subclase de
 * `OcrFailedError` para que el caller pueda distinguir (respuesta
 * diferente al user: "la imagen tardó demasiado").
 */
export class OcrTimeoutError extends OcrFailedError {
  constructor(
    message: string,
    options: { timeoutMs?: number; cause?: unknown; metadata?: AppErrorMetadata } = {},
  ) {
    super(message, {
      ...options,
      metadata: { ...(options.metadata ?? {}), timeoutMs: options.timeoutMs },
    });
  }
}
