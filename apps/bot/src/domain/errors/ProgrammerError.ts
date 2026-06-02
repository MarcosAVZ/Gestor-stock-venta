/**
 * ProgrammerError — base para errores de código (5xx).
 *
 * Indica un bug: una invariante del dominio fue violada, una
 * dependencia crítica no se inicializó, o se pasó un argumento que
 * el type system no atrapa. NO se debe responder al usuario con
 * detalles: el handler loggea stack + requestId y devuelve un
 * mensaje genérico ("Hubo un error, probá de nuevo más tarde.").
 *
 * Subclases: InvariantViolationError, MissingDependencyError.
 */

import { AppError, type AppErrorMetadata } from './AppError.ts';

export class ProgrammerError extends AppError {
  constructor(
    code: string,
    message: string,
    options: { cause?: unknown; metadata?: AppErrorMetadata } = {},
  ) {
    super(code, message, { isOperational: false, ...options });
  }
}

/**
 * Una invariante del dominio fue violada. Indica un bug: el estado
 * llegó a un punto que el código no debería haber permitido.
 *
 * Ejemplos:
 * - `transition()` del state machine recibe (estado, evento) que la
 *   tabla marca como inválido y aún así estamos acá.
 * - `CalcularMetricas` recibe `cantidadLote = 0`.
 */
export class InvariantViolationError extends ProgrammerError {
  constructor(
    message: string,
    options: { cause?: unknown; metadata?: AppErrorMetadata } = {},
  ) {
    super('invariant_violation', message, options);
  }
}

/**
 * Una dependencia crítica no fue inicializada o no se pasó por
 * constructor. Ejemplo: usar `prisma.compra.findFirst` sin antes
 * inyectar el PrismaClient en el composition root.
 */
export class MissingDependencyError extends ProgrammerError {
  constructor(
    dependencyName: string,
    options: { cause?: unknown; metadata?: AppErrorMetadata } = {},
  ) {
    super('missing_dependency', `Missing required dependency: ${dependencyName}`, {
      ...options,
      metadata: { ...(options.metadata ?? {}), dependency: dependencyName },
    });
  }
}
