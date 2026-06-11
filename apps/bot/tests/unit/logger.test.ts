/**
 * Tests del logger Pino + redact de PII.
 *
 * Cubre:
 * - Logger level respetado de env.
 * - Redact paths: phone, body, imageUrl, sessionPath + variantes
 *   anidadas (metadata.phone, context.body) → [REDACTED].
 * - Otros campos NO redactados.
 * - logSecurityEvent: shape consistente { type: 'security', event }.
 *   Levels: warn para unauthorized_access/rate_limit_hit; error para
 *   unhandled_rejection/uncaught_exception.
 * - Base fields: service=sgcw-bot y env=NODE_ENV presentes.
 * - ISO timestamp (no epoch).
 */

import { describe, expect, it, vi } from 'vitest';

import { buildLogger, logSecurityEvent } from '../../src/infrastructure/logging/logger.ts';
import type { Env } from '../../src/config/env.ts';

const baseEnv: Env = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
  OWNER_PHONE_NUMBERS: ['+5491112345678'],
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  PORT: 3000,
  SESSION_PATH: './data/sessions',
  RATE_LIMIT_MESSAGE_MS: 2000,
  RATE_LIMIT_DAILY_COMPRAS: 30,
  INACTIVITY_TIMEOUT_MIN: 15,
};

/** Captura process.stdout.write para inspeccionar el output del logger. */
function spyStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((data: unknown) => {
      const text =
        typeof data === 'string'
          ? data
          : data instanceof Buffer
            ? data.toString()
            : String(data);
      writes.push(text);
      return true;
    });
  return { writes, restore: () => spy.mockRestore() };
}

describe('logger', () => {
  describe('buildLogger()', () => {
    it('returns a logger with the requested level (debug)', () => {
      const logger = buildLogger({ ...baseEnv, LOG_LEVEL: 'debug' });
      expect(logger.level).toBe('debug');
    });

    it('returns a logger with the requested level (warn)', () => {
      const logger = buildLogger({ ...baseEnv, LOG_LEVEL: 'warn' });
      expect(logger.level).toBe('warn');
    });

    it('returns a logger with the requested level (trace)', () => {
      const logger = buildLogger({ ...baseEnv, LOG_LEVEL: 'trace' });
      expect(logger.level).toBe('trace');
    });

    it('does not throw in development (pino-pretty transport)', () => {
      const logger = buildLogger({ ...baseEnv, NODE_ENV: 'development' });
      expect(logger).toBeDefined();
    });

    it('does not throw in production (JSON output)', () => {
      const logger = buildLogger({ ...baseEnv, NODE_ENV: 'production' });
      expect(logger).toBeDefined();
    });
  });

  describe('redact paths (OWASP A05)', () => {
    it('redacts top-level phone, body, imageUrl, sessionPath', () => {
      const { writes, restore } = spyStdout();
      try {
        const logger = buildLogger({ ...baseEnv, LOG_LEVEL: 'trace' });
        logger.info(
          { phone: '+5491199999999', body: 'hola', imageUrl: 'foo.jpg', sessionPath: './data/s' },
          'redact test',
        );
        const output = writes.join('');
        expect(output).toContain('[REDACTED]');
        expect(output).not.toContain('+5491199999999');
        expect(output).not.toContain('hola');
        expect(output).not.toContain('foo.jpg');
      } finally {
        restore();
      }
    });

    it('redacts nested metadata.phone and context.body', () => {
      const { writes, restore } = spyStdout();
      try {
        const logger = buildLogger({ ...baseEnv, LOG_LEVEL: 'trace' });
        logger.info(
          {
            metadata: { phone: '+5491111111111', body: 'msg', note: 'visible' },
            context: { body: 'should be redacted too' },
          },
          'nested redact test',
        );
        const output = writes.join('');
        expect(output).not.toContain('+5491111111111');
        expect(output).not.toContain('should be redacted too');
        expect(output).toContain('visible');
        expect(output).toContain('[REDACTED]');
      } finally {
        restore();
      }
    });

    it('does NOT redact unrelated fields', () => {
      const { writes, restore } = spyStdout();
      try {
        const logger = buildLogger({ ...baseEnv, LOG_LEVEL: 'trace' });
        logger.info(
          { event: 'whatsapp_ready', requestId: 'abc-123', count: 42 },
          'no redact test',
        );
        const output = writes.join('');
        expect(output).toContain('whatsapp_ready');
        expect(output).toContain('abc-123');
        expect(output).toContain('42');
      } finally {
        restore();
      }
    });
  });

  describe('logSecurityEvent()', () => {
    it('emits security event with consistent shape', () => {
      const { writes, restore } = spyStdout();
      try {
        const logger = buildLogger({ ...baseEnv, LOG_LEVEL: 'trace' });
        logSecurityEvent(logger, 'unauthorized_access', { phone: '+54911secret' });
        const output = writes.join('');
        expect(output).toContain('"type":"security"');
        expect(output).toContain('"event":"unauthorized_access"');
        expect(output).toContain('[REDACTED]');
        expect(output).not.toContain('+54911secret');
        expect(output).toContain('security: unauthorized_access');
      } finally {
        restore();
      }
    });

    it('uses warn level (40) for non-fatal security events', () => {
      const { writes, restore } = spyStdout();
      try {
        const logger = buildLogger({ ...baseEnv, LOG_LEVEL: 'trace' });
        logSecurityEvent(logger, 'rate_limit_hit', { phone: '+1', type: 'image_burst' });
        const output = writes.join('');
        expect(output).toContain('"level":40');
      } finally {
        restore();
      }
    });

    it('uses error level (50) for unhandled_rejection and uncaught_exception', () => {
      const { writes, restore } = spyStdout();
      try {
        const logger = buildLogger({ ...baseEnv, LOG_LEVEL: 'trace' });
        logSecurityEvent(logger, 'unhandled_rejection', { reason: 'string reason' });
        const output = writes.join('');
        expect(output).toContain('"level":50');
      } finally {
        restore();
      }
    });

    it('uses error level (50) for uncaught_exception', () => {
      const { writes, restore } = spyStdout();
      try {
        const logger = buildLogger({ ...baseEnv, LOG_LEVEL: 'trace' });
        logSecurityEvent(logger, 'uncaught_exception', { err: 'fake' });
        const output = writes.join('');
        expect(output).toContain('"level":50');
      } finally {
        restore();
      }
    });

    it('includes arbitrary metadata in the log entry', () => {
      const { writes, restore } = spyStdout();
      try {
        const logger = buildLogger({ ...baseEnv, LOG_LEVEL: 'trace' });
        logSecurityEvent(logger, 'state_transition_invalid', {
          from: 'ESPERANDO_IMAGEN',
          event: 'CANTIDAD_RECIBIDA',
        });
        const output = writes.join('');
        expect(output).toContain('"from":"ESPERANDO_IMAGEN"');
        expect(output).toContain('"event":"CANTIDAD_RECIBIDA"');
      } finally {
        restore();
      }
    });
  });

  describe('base fields', () => {
    it('always includes service=sgcw-bot and env=NODE_ENV', () => {
      const { writes, restore } = spyStdout();
      try {
        const logger = buildLogger({ ...baseEnv, NODE_ENV: 'test', LOG_LEVEL: 'trace' });
        logger.info('hello');
        const output = writes.join('');
        expect(output).toContain('"service":"sgcw-bot"');
        expect(output).toContain('"env":"test"');
      } finally {
        restore();
      }
    });

    it('uses ISO timestamp', () => {
      const { writes, restore } = spyStdout();
      try {
        const logger = buildLogger({ ...baseEnv, LOG_LEVEL: 'trace' });
        logger.info('ts test');
        const output = writes.join('');
        expect(output).toMatch(/"time":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      } finally {
        restore();
      }
    });
  });
});
