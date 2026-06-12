/**
 * @compras-whatsapp/bot — Pino logger con redact de PII.
 *
 * Decisiones locked (ver sdd-design obs#28 sección "Logger" + spec
 * req-observabilidad):
 *
 * 1. **Redact paths**: `phone`, `body`, `imageUrl`, `sessionPath`,
 *    `*.phone`, `*.body`. Pino los reemplaza por `[REDACTED]` antes
 *    de serializar a stdout. Esto cubre OWASP A05 (Sensitive Data
 *    Exposure) — nunca loggeamos el cuerpo del mensaje del usuario
 *    ni el teléfono en claro.
 *
 * 2. **Formato**: en dev usa `pino-pretty` con colorize para legibilidad
 *    en consola; en prod JSON puro para que agregadores (Loki, ELK,
 *    Datadog) lo parseen. Decisión por NODE_ENV, no por env var
 *    separada: si corrés prod querés JSON, punto.
 *
 * 3. **Singleton**: el logger se exporta como `logger` y se reusa en
 *    toda la app. NO instanciar un Pino nuevo por archivo — eso
 *    rompe el filtrado de redact y la consistencia de timestamps.
 *
 * 4. **Helpers**: `logSecurityEvent` centraliza el shape de los
 *    eventos de seguridad (OWASP A09) — siempre `{ type: 'security',
 *    event, ...metadata }`. Esto facilita alerting en prod.
 *
 * 5. **Pino en lugar de Winston**: Pino es ~5x más rápido (importante
 *    en un bot con 1-3 usuarios pero picos por bursts de imágenes) y
 *    tiene redact built-in, sin plugin extra.
 */

import { pino, type Logger, type LoggerOptions } from 'pino';
import type { Env } from '../../config/env.ts';

/**
 * Construye un logger Pino configurado para el entorno actual.
 * Se exporta la factory (no la instancia) porque el logger depende
 * del env (log level, formato dev/prod) y este archivo NO debe
 * importar `loadEnv()` directamente — eso sería una dependencia
 * circular (env.ts loggea con console.error; logger.ts lee env).
 * El container (PR3 task 3.10) es el único que llama `buildLogger(env)`.
 */
export function buildLogger(env: Env): Logger {
  const isDev = env.NODE_ENV === 'development';

  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        'phone',
        'body',
        'imageUrl',
        'sessionPath',
        '*.phone',
        '*.body',
        '*.imageUrl',
        '*.sessionPath',
        // paths anidados comunes en objetos de error y request context
        'metadata.phone',
        'metadata.body',
        'metadata.from',
        'context.phone',
        'context.body',
      ],
      censor: '[REDACTED]',
    },
    // En prod, JSON a stdout. En dev, pino-pretty para legibilidad.
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
    // Campos base que SIEMPRE se incluyen
    base: {
      service: 'sgcw-bot',
      env: env.NODE_ENV,
    },
    // Formato de timestamp ISO (más portable que epoch por default de Pino)
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return pino(options);
}

/**
 * Helper para loggear eventos de seguridad de forma consistente.
 * OWASP A09 (Security Logging Failures) requiere que eventos
 * sensibles queden registrados con un shape reconocible para
 * alertas automáticas.
 *
 * Uso:
 *   logSecurityEvent(logger, 'unauthorized_access', { phone: '+54911...' });
 *   logSecurityEvent(logger, 'rate_limit_hit', { phone, type: 'image_burst' });
 *   logSecurityEvent(logger, 'state_transition_invalid', { from, event });
 */
export function logSecurityEvent(
  logger: Logger,
  event:
    | 'unauthorized_access'
    | 'rate_limit_hit'
    | 'state_transition_invalid'
    | 'whatsapp_disconnected'
    | 'whatsapp_reconnected'
    | 'whatsapp_session_restored'
    | 'whatsapp_qr_ready'
    | 'unhandled_rejection'
    | 'uncaught_exception'
    | 'media_downloaded'
    | 'send_failed',

  metadata: Record<string, unknown> = {},
): void {
  // level warn para la mayoría; error para unhandled_rejection/uncaught_exception.
  const level: 'warn' | 'error' =
    event === 'unhandled_rejection' || event === 'uncaught_exception' ? 'error' : 'warn';

  // NOTA: Pino redact paths aplican automáticamente — si `metadata`
  // tiene `phone`, aparecerá como `[REDACTED]`. Lo mantenemos en la
  // firma para que el llamador no tenga que hacer `metadata_redacted = { ...md, phone: '[REDACTED]' }`.
  logger[level]({ type: 'security', event, ...metadata }, `security: ${event}`);
}
