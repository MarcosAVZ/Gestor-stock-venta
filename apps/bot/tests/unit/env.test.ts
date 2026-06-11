/**
 * Tests del loader de env.
 *
 * Cubre:
 * - Happy path: env mínimo válido parsea con defaults.
 * - Phone E.164: rechaza formatos inválidos con mensaje claro.
 * - Phone list: comma-separated, trim, al menos 1.
 * - DATABASE_URL: rechaza URLs que no son postgres.
 * - Number coercion: PORT, RATE_LIMIT_* desde string.
 * - Invalid env retorna issues estructurados (no throw).
 * - loadEnv() hace process.exit(1) en fallo (mockeado).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { envSchema, loadEnv, parseEnv } from '../../src/config/env.ts';

const baseValidEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  OWNER_PHONE_NUMBERS: '+5491112345678',
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
};

describe('env loader', () => {
  describe('happy path', () => {
    it('parses a minimal valid env with defaults', () => {
      const result = parseEnv(baseValidEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.DATABASE_URL).toBe(baseValidEnv.DATABASE_URL);
        expect(result.data.OWNER_PHONE_NUMBERS).toEqual(['+5491112345678']);
        expect(result.data.PORT).toBe(3000);
        expect(result.data.SESSION_PATH).toBe('./data/sessions');
        expect(result.data.RATE_LIMIT_MESSAGE_MS).toBe(2000);
        expect(result.data.RATE_LIMIT_DAILY_COMPRAS).toBe(30);
        expect(result.data.INACTIVITY_TIMEOUT_MIN).toBe(15);
        expect(result.data.NODE_ENV).toBe('development');
        expect(result.data.LOG_LEVEL).toBe('info');
      }
    });

    it('parses multiple phones with trim', () => {
      const result = parseEnv({
        ...baseValidEnv,
        OWNER_PHONE_NUMBERS: ' +5491112345678 , +5491198765432 ,+5491100000000 ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.OWNER_PHONE_NUMBERS).toEqual([
          '+5491112345678',
          '+5491198765432',
          '+5491100000000',
        ]);
      }
    });
  });

  describe('phone validation', () => {
    it('rejects phone without + prefix', () => {
      const result = parseEnv({ ...baseValidEnv, OWNER_PHONE_NUMBERS: '5491112345678' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('OWNER_PHONE_NUMBERS'))).toBe(
          true,
        );
      }
    });

    it('rejects phone starting with 0 after +', () => {
      const result = parseEnv({ ...baseValidEnv, OWNER_PHONE_NUMBERS: '+05491112345678' });
      expect(result.success).toBe(false);
    });

    it('rejects phone too short', () => {
      const result = parseEnv({ ...baseValidEnv, OWNER_PHONE_NUMBERS: '+12345' });
      expect(result.success).toBe(false);
    });

    it('rejects phone too long', () => {
      const result = parseEnv({
        ...baseValidEnv,
        OWNER_PHONE_NUMBERS: '+12345678901234567890',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty OWNER_PHONE_NUMBERS', () => {
      const result = parseEnv({ ...baseValidEnv, OWNER_PHONE_NUMBERS: '' });
      expect(result.success).toBe(false);
    });

    it('rejects list of all empty strings (filter leaves 0)', () => {
      const result = parseEnv({ ...baseValidEnv, OWNER_PHONE_NUMBERS: ',,,' });
      expect(result.success).toBe(false);
    });
  });

  describe('DATABASE_URL', () => {
    it('rejects empty', () => {
      const result = parseEnv({ ...baseValidEnv, DATABASE_URL: '' });
      expect(result.success).toBe(false);
    });

    it('rejects non-postgres URL', () => {
      const result = parseEnv({ ...baseValidEnv, DATABASE_URL: 'mysql://localhost/db' });
      expect(result.success).toBe(false);
    });

    it('rejects non-URL', () => {
      const result = parseEnv({ ...baseValidEnv, DATABASE_URL: 'not-a-url' });
      expect(result.success).toBe(false);
    });
  });

  describe('number coercion', () => {
    it('coerces PORT from string', () => {
      const result = parseEnv({ ...baseValidEnv, PORT: '8080' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.PORT).toBe(8080);
    });

    it('rejects PORT out of range', () => {
      const result = parseEnv({ ...baseValidEnv, PORT: '99999' });
      expect(result.success).toBe(false);
    });

    it('coerces RATE_LIMIT_* from string', () => {
      const result = parseEnv({
        ...baseValidEnv,
        RATE_LIMIT_MESSAGE_MS: '5000',
        RATE_LIMIT_DAILY_COMPRAS: '50',
        INACTIVITY_TIMEOUT_MIN: '30',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.RATE_LIMIT_MESSAGE_MS).toBe(5000);
        expect(result.data.RATE_LIMIT_DAILY_COMPRAS).toBe(50);
        expect(result.data.INACTIVITY_TIMEOUT_MIN).toBe(30);
      }
    });

    it('rejects non-numeric PORT', () => {
      const result = parseEnv({ ...baseValidEnv, PORT: 'abc' });
      expect(result.success).toBe(false);
    });
  });

  describe('NODE_ENV + LOG_LEVEL enums', () => {
    it('accepts production NODE_ENV', () => {
      const result = parseEnv({ ...baseValidEnv, NODE_ENV: 'production' });
      expect(result.success).toBe(true);
    });

    it('rejects unknown NODE_ENV', () => {
      const result = parseEnv({ ...baseValidEnv, NODE_ENV: 'staging' });
      expect(result.success).toBe(false);
    });

    it('accepts all pino levels', () => {
      for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
        const result = parseEnv({ ...baseValidEnv, LOG_LEVEL: level });
        expect(result.success).toBe(true);
      }
    });

    it('rejects unknown LOG_LEVEL', () => {
      const result = parseEnv({ ...baseValidEnv, LOG_LEVEL: 'verbose' });
      expect(result.success).toBe(false);
    });
  });

  describe('loadEnv()', () => {
    let originalEnv: NodeJS.ProcessEnv;
    let exitMock: { mockRestore: () => void };
    let errorMock: { mockRestore: () => void };

    beforeEach(() => {
      originalEnv = process.env;
      // @ts-expect-error: vitest mock typing for process.exit is awkward
      exitMock = vi.spyOn(process, 'exit').mockImplementation((code: number) => {
        throw new Error(`__exit_${code ?? '0'}`);
      });
      errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      process.env = originalEnv;
      exitMock.mockRestore();
      errorMock.mockRestore();
    });

    it('returns parsed env on success', () => {
      process.env = { ...baseValidEnv };
      const env = loadEnv();
      expect(env.DATABASE_URL).toBe(baseValidEnv.DATABASE_URL);
      expect(env.OWNER_PHONE_NUMBERS).toEqual(['+5491112345678']);
    });

    it('logs to console.error and exits with code 1 on invalid env', () => {
      process.env = { DATABASE_URL: 'invalid', OWNER_PHONE_NUMBERS: 'bad' };
      expect(() => loadEnv()).toThrow('__exit_1');
      expect(errorMock).toHaveBeenCalled();
      const message = String((errorMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] ?? '');
      expect(message).toContain('Invalid environment configuration');
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('OWNER_PHONE_NUMBERS');
    });
  });

  describe('envSchema type exports', () => {
    it('exposes the schema for downstream use', () => {
      expect(envSchema).toBeDefined();
      expect(typeof envSchema.safeParse).toBe('function');
    });
  });
});
