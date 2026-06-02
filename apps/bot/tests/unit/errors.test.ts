/**
 * Tests unitarios de la jerarquía AppError.
 *
 * Cubren:
 * - Discriminación isOperational (operational vs programmer)
 * - Code estable por subclase
 * - Metadata inmutable
 * - toJSON serializa lo necesario sin filtrar stack
 * - Captura de `cause` para error chaining
 * - Stack trace no apunta a la clase base
 */

import { describe, expect, test } from 'vitest';

import { AppError } from '../../src/domain/errors/AppError.ts';
import {
  NotFoundError,
  OperationalError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '../../src/domain/errors/OperationalError.ts';
import { InvariantViolationError, MissingDependencyError, ProgrammerError } from '../../src/domain/errors/ProgrammerError.ts';

describe('AppError hierarchy', () => {
  describe('operational errors', () => {
    test('NotFoundError exposes resource + criteria in metadata', () => {
      const err = new NotFoundError('Compra', 'abc123');
      expect(err.isOperational).toBe(true);
      expect(err.code).toBe('not_found');
      expect(err.message).toBe('Compra not found: abc123');
      expect(err.metadata).toEqual({ resource: 'Compra', criteria: 'abc123' });
    });

    test('ValidationError attaches field name to metadata', () => {
      const err = new ValidationError('cantidad must be > 0', { field: 'cantidad' });
      expect(err.isOperational).toBe(true);
      expect(err.code).toBe('validation_error');
      expect(err.metadata).toMatchObject({ field: 'cantidad' });
    });

    test('UnauthorizedError hides the offending phone in the message', () => {
      // OWASP A01: el message genérico NO debe filtrar el número/email.
      const err = new UnauthorizedError({ metadata: { from: '+5491199999999' } });
      expect(err.message).toBe('No autorizado.');
      expect(err.code).toBe('unauthorized');
      // El detalle queda solo en metadata (para log interno, no respuesta al user).
      expect(err.metadata).toEqual({ from: '+5491199999999' });
    });

    test('RateLimitError carries retryAfterSec', () => {
      const err = new RateLimitError('Demasiadas imágenes.', { retryAfterSec: 10 });
      expect(err.isOperational).toBe(true);
      expect(err.code).toBe('rate_limit');
      expect(err.metadata).toMatchObject({ retryAfterSec: 10 });
    });

    test('OperationalError base is still operational', () => {
      const err = new OperationalError('custom_op', 'algo', { metadata: { k: 'v' } });
      expect(err.isOperational).toBe(true);
      expect(err.code).toBe('custom_op');
    });
  });

  describe('programmer errors', () => {
    test('InvariantViolationError is NOT operational', () => {
      const err = new InvariantViolationError('estado inconsistente');
      expect(err.isOperational).toBe(false);
      expect(err.code).toBe('invariant_violation');
    });

    test('MissingDependencyError includes the dependency name', () => {
      const err = new MissingDependencyError('PrismaClient');
      expect(err.isOperational).toBe(false);
      expect(err.code).toBe('missing_dependency');
      expect(err.message).toBe('Missing required dependency: PrismaClient');
      expect(err.metadata).toEqual({ dependency: 'PrismaClient' });
    });

    test('ProgrammerError base is non-operational', () => {
      const err = new ProgrammerError('custom_bug', 'explota');
      expect(err.isOperational).toBe(false);
    });
  });

  describe('common behavior', () => {
    test('all errors extend AppError + Error', () => {
      const err = new NotFoundError('X', '1');
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
    });

    test('metadata is frozen (cannot be mutated)', () => {
      const err = new ValidationError('x', { metadata: { a: 1 } });
      expect(() => {
        (err.metadata as Record<string, unknown>)['a'] = 2;
      }).toThrow();
    });

    test('toJSON returns a serializable shape', () => {
      const err = new RateLimitError('msg', { retryAfterSec: 5 });
      const json = err.toJSON();
      expect(json).toMatchObject({
        name: 'RateLimitError',
        code: 'rate_limit',
        message: 'msg',
        isOperational: true,
      });
      // No debe filtrar el stack al serializar.
      expect('stack' in json).toBe(false);
    });

    test('preserves cause for error chaining', () => {
      const root = new Error('DB connection refused');
      const wrapped = new InvariantViolationError('cannot proceed', { cause: root });
      expect(wrapped.cause).toBe(root);
    });

    test('stack trace points to constructor, not to AppError base', () => {
      const err = new NotFoundError('Compra', 'x');
      // El stack NO debe contener "at new AppError" como frame principal;
      // sí debe contener la línea de creación de este test.
      expect(err.stack).toBeDefined();
      expect(err.stack).not.toMatch(/at new AppError\b/);
    });
  });
});
