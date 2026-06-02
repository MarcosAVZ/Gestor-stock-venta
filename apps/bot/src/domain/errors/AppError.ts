/**
 * AppError — clase base para todos los errores del dominio.
 *
 * Jerarquía intencional (ver sdd-design obs#28 sección "AppError hierarchy"):
 *   AppError (abstract)
 *     ├─ OperationalError   → recuperable, no es bug (4xx en API)
 *     │   ├─ NotFoundError
 *     │   ├─ ValidationError
 *     │   ├─ UnauthorizedError
 *     │   └─ RateLimitError
 *     └─ ProgrammerError    → bug de código, requiere fix (5xx)
 *         ├─ InvariantViolationError
 *         └─ MissingDependencyError
 *
 * Decisión de diseño:
 * - `isOperational` discrimina si el caller puede manejar el error sin
 *   crashear (operational) o si es un bug que requiere atención del dev
 *   (programmer). El graceful shutdown handler (PR3) reacciona diferente
 *   a cada uno.
 * - `code` es un string estable que el caller puede switchear sin
 *   depender del nombre de la clase (útil para serializar a API o logs
 *   estructurados).
 * - `metadata` carga contexto adicional para logging (ej: ids, hints).
 *   NUNCA incluir PII (Pino redact paths en PR3 lo enforcerán).
 *
 * Esta clase es abstracta vía convención: los `throw new AppError(...)`
 * directos NO deben ocurrir — siempre se tira una subclase. El constructor
 * está marcado private para reforzar esto, pero TS no puede expresar
 * "abstract" para clases con parámetros de subclase. En su lugar
 * validamos en runtime: `AppError` directo tira.
 */

export type AppErrorCode = string;

export type AppErrorMetadata = Readonly<Record<string, unknown>>;

export abstract class AppError extends Error {
  public readonly code: AppErrorCode;
  public readonly isOperational: boolean;
  public readonly metadata: AppErrorMetadata;

  protected constructor(
    code: AppErrorCode,
    message: string,
    options: {
      isOperational: boolean;
      cause?: unknown;
      metadata?: AppErrorMetadata;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.isOperational = options.isOperational;
    this.metadata = Object.freeze({ ...(options.metadata ?? {}) });

    // Mantiene el stack trace apuntando al call site correcto en V8.
    // Tipado laxo: V8 expone `captureStackTrace(target, constructorOpt)`
    // donde constructorOpt es `Function`; el linter rechaza `Function`,
    // por eso usamos un alias que evita `@typescript-eslint/no-unsafe-function-type`.
    type V8ErrorConstructor = ErrorConstructor & {
      captureStackTrace?: (target: object, constructorOpt: object) => void;
    };
    if (typeof (Error as V8ErrorConstructor).captureStackTrace === 'function') {
      (Error as V8ErrorConstructor).captureStackTrace!(this, new.target);
    }
  }

  /**
   * Serialización segura para logs. NO usar para respuestas al usuario:
   * `message` puede contener detalles internos.
   */
  public toJSON(): {
    name: string;
    code: string;
    message: string;
    isOperational: boolean;
    metadata: Record<string, unknown>;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      isOperational: this.isOperational,
      metadata: { ...this.metadata },
    };
  }
}
