/**
 * @compras-whatsapp/bot — environment loader (Zod-validated)
 *
 * Valida `process.env` con Zod al arranque. Si algo no cumple el schema
 * falla LO ANTES POSIBLE con un mensaje claro: el bot no arranca con
 * configuración inválida. Esto es defensa en profundidad (fail-fast):
 * la alternativa — defaults silenciosos — lleva a bugs de producción
 * donde un env var faltante se descubre cuando el usuario manda un
 * mensaje y el bot no responde.
 *
 * Reglas locked (ver sdd-design obs#28 sección 2, env vars):
 * - `OWNER_PHONE_NUMBERS`: comma-separated, cada uno E.164 (`+[1-9]\d{6,14}`).
 *   OWASP A01: el número del dueño NUNCA debería estar vacío en prod.
 * - `DATABASE_URL`: requerido en runtime; URL Postgres válida.
 * - `LOG_LEVEL`: pino level; default `info`.
 * - `SESSION_PATH` / `IMAGES_PATH`: filesystem paths; default `./data/...`.
 * - `RATE_LIMIT_*`: rate limits en ms/día. Defaults razonable para MVP.
 *
 * Decisión de implementación: si la validación falla, loggea a
 * `console.error` (no Pino) y `process.exit(1)`. Pino no se puede
 * instanciar hasta que sepamos que `LOG_LEVEL` es válido, así que
 * durante el bootstrap usamos stderr. Esto es el mismo patrón que
 * Pino, Express y todos los frameworks Node usan.
 */

import { z } from 'zod';

// ── Phone number schema ─────────────────────────────────────────────

/** E.164 formato: `+` seguido de 7-15 dígitos, el primero no-cero. */
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

/** Comma-separated list de teléfonos E.164; al menos 1. */
const ownerPhoneListSchema = z
  .string()
  .min(1, 'OWNER_PHONE_NUMBERS is required and must contain at least one phone')
  .transform((raw, ctx) => {
    const phones = raw
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (phones.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OWNER_PHONE_NUMBERS must contain at least one valid E.164 phone',
      });
      return z.NEVER;
    }
    const invalid = phones.find((p) => !E164_REGEX.test(p));
    if (invalid !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid E.164 phone in OWNER_PHONE_NUMBERS: "${invalid}" (expected format: +[1-9] followed by 6-14 digits)`,
      });
      return z.NEVER;
    }
    return phones;
  });

// ── Main env schema ─────────────────────────────────────────────────

export const envSchema = z.object({
  /** Postgres connection string. */
  DATABASE_URL: z
    .string()
    .url('DATABASE_URL must be a valid URL (postgresql://...)')
    .refine(
      (u) => u.startsWith('postgres://') || u.startsWith('postgresql://'),
      'DATABASE_URL must use the postgres:// or postgresql:// protocol',
    ),

  /** Comma-separated whitelist de teléfonos del dueño (E.164). */
  OWNER_PHONE_NUMBERS: ownerPhoneListSchema,

  /** Runtime mode. */
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /** Pino log level. */
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  /** HTTP server port (healthcheck). */
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /** Directorio donde whatsapp-web.js persiste la sesión. */
  SESSION_PATH: z.string().min(1).default('./data/sessions'),

  /** Directorio donde se guardan las imágenes descargadas. */
  IMAGES_PATH: z.string().min(1).default('./data/images'),

  /** Concurrencia del pool OCR. */
  OCR_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),

  /** Timeout por imagen OCR (ms). */
  OCR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),

  /** Rate limit: ms mínimos entre mensajes de texto. */
  RATE_LIMIT_MESSAGE_MS: z.coerce.number().int().min(0).max(60000).default(2000),

  /** Rate limit: ms mínimos entre imágenes. */
  RATE_LIMIT_IMAGE_MS: z.coerce.number().int().min(0).max(60000).default(10000),

  /** Rate limit: máximo de compras por día por usuario. */
  RATE_LIMIT_DAILY_COMPRAS: z.coerce.number().int().min(1).max(10000).default(30),

  /** Minutos de inactividad antes de reset de conversación. */
  INACTIVITY_TIMEOUT_MIN: z.coerce.number().int().min(1).max(1440).default(15),
});

export type Env = z.infer<typeof envSchema>;

// ── Loader ──────────────────────────────────────────────────────────

/**
 * Carga y valida `process.env`. Si algo falla, loggea a stderr
 * (no podemos usar Pino todavía porque LOG_LEVEL podría ser el
 * problema) y `process.exit(1)`.
 *
 * El log de error es multiline y orientado al dev/ops: muestra
 * QUÉ campo falló, POR QUÉ (mensaje de Zod), y el path al ejemplo
 * `.env.example`. Fail-fast > defaults silenciosos.
 */
export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((iss) => `  - ${iss.path.join('.') || '(root)'}: ${iss.message}`)
      .join('\n');
    // Usamos console.error porque Pino aún no está instanciado.
    console.error(
      `[env] Invalid environment configuration:\n${issues}\n\n` +
        `Tip: copy .env.example to .env and fill the required values.\n` +
        `Required: DATABASE_URL, OWNER_PHONE_NUMBERS (comma-separated E.164).`,
    );
    process.exit(1);
  }
  return result.data;
}

/**
 * Versión no-exit de `loadEnv`. Útil para tests (no queremos matar
 * el proceso del test runner). Retorna el resultado crudo de Zod.
 */
export function parseEnv(env: NodeJS.ProcessEnv) {
  return envSchema.safeParse(env);
}
