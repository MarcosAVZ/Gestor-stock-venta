/**
 * Tests del RateLimiter per-phone.
 *
 * Cubre:
 * - canSendMessage: allowed al primer mensaje; rejected durante cooldown;
 *   allowed después del cooldown.
 * - canSaveCompra: allowed hasta N; rejected al N+1; allowed después
 *   de 24h (con fake timers).
 * - recordMessage / recordCompra: append timestamps.
 * - dailyCompraCount: rolling window de 24h.
 * - Reset independiente entre phones (un phone saturado no afecta otro).
 * - Verdict shape: allowed + retryAfterSec + reason.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '../../src/infrastructure/messaging/rateLimiter.ts';

const NOW = 1_700_000_000_000; // epoch fijo
const config = { messageMs: 2000, dailyCompras: 30 };

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('canSendMessage / recordMessage', () => {
    it('allows the first message from a phone', () => {
      const rl = new RateLimiter(config);
      const verdict = rl.canSendMessage('+5491111111111');
      expect(verdict.allowed).toBe(true);
      expect(verdict.retryAfterSec).toBe(0);
      expect(verdict.reason).toBeUndefined();
    });

    it('rejects a second message within the cooldown', () => {
      const rl = new RateLimiter(config);
      rl.recordMessage('+5491111111111');
      vi.advanceTimersByTime(500); // 0.5s después
      const verdict = rl.canSendMessage('+5491111111111');
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe('message_cooldown');
      // retryAfterSec: ceil((2000 - 500) / 1000) = 2
      expect(verdict.retryAfterSec).toBe(2);
    });

    it('allows again after the cooldown elapses', () => {
      const rl = new RateLimiter(config);
      rl.recordMessage('+5491111111111');
      vi.advanceTimersByTime(2001);
      const verdict = rl.canSendMessage('+5491111111111');
      expect(verdict.allowed).toBe(true);
    });

    it('does not record the timestamp if canSendMessage is not paired with recordMessage', () => {
      const rl = new RateLimiter(config);
      rl.canSendMessage('+5491111111111');
      // Si el caller olvidó record, el siguiente check sigue permitido.
      vi.advanceTimersByTime(100);
      expect(rl.canSendMessage('+5491111111111').allowed).toBe(true);
    });
  });

  describe('canSaveCompra / dailyCompraCount', () => {
    it('allows up to dailyCompras purchases', () => {
      const rl = new RateLimiter({ ...config, dailyCompras: 3 });
      rl.recordCompra('+5491111111111');
      rl.recordCompra('+5491111111111');
      rl.recordCompra('+5491111111111');
      expect(rl.canSaveCompra('+5491111111111').allowed).toBe(false);
      expect(rl.dailyCompraCount('+5491111111111')).toBe(3);
    });

    it('rejects with reason daily_compras_exceeded', () => {
      const rl = new RateLimiter({ ...config, dailyCompras: 1 });
      rl.recordCompra('+5491111111111');
      const verdict = rl.canSaveCompra('+5491111111111');
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe('daily_compras_exceeded');
    });

    it('forgets purchases older than 24h (rolling window)', () => {
      const rl = new RateLimiter({ ...config, dailyCompras: 2 });
      rl.recordCompra('+5491111111111');
      rl.recordCompra('+5491111111111');
      // 24h + 1s después
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1000);
      // Las dos compras viejas se purgan en el primer canSaveCompra
      expect(rl.canSaveCompra('+5491111111111').allowed).toBe(true);
      expect(rl.dailyCompraCount('+5491111111111')).toBe(0);
    });
  });

  describe('phone isolation', () => {
    it('one phone saturation does not affect another', () => {
      const rl = new RateLimiter(config);
      rl.recordMessage('+5491111111111');
      vi.advanceTimersByTime(500);
      expect(rl.canSendMessage('+5491111111111').allowed).toBe(false);
      expect(rl.canSendMessage('+5491199999999').allowed).toBe(true);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      const rl = new RateLimiter(config);
      rl.recordMessage('+5491111111111');
      rl.recordCompra('+5491111111111');
      rl.reset();
      expect(rl.canSendMessage('+5491111111111').allowed).toBe(true);
      expect(rl.dailyCompraCount('+5491111111111')).toBe(0);
    });
  });

  describe('verdict shape', () => {
    it('contains allowed=false + retryAfterSec > 0 for cooldown rejections', () => {
      const rl = new RateLimiter({ ...config, messageMs: 5000 });
      rl.recordMessage('+5491111111111');
      vi.advanceTimersByTime(1000);
      const verdict = rl.canSendMessage('+5491111111111');
      expect(verdict).toEqual({
        allowed: false,
        retryAfterSec: 4,
        reason: 'message_cooldown',
      });
    });

    it('contains allowed=false + retryAfterSec=0 for daily limit', () => {
      const rl = new RateLimiter({ ...config, dailyCompras: 1 });
      rl.recordCompra('+5491111111111');
      const verdict = rl.canSaveCompra('+5491111111111');
      expect(verdict.allowed).toBe(false);
      expect(verdict.retryAfterSec).toBe(0);
      expect(verdict.reason).toBe('daily_compras_exceeded');
    });
  });
});
