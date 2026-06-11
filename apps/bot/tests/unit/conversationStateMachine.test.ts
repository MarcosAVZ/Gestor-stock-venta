/**
 * Tests del ConversationStateMachine — Text Command Bot rewrite.
 *
 * Cubre:
 * - Happy path transitions (9 state-specific + 3 global)
 * - Global transitions (CANCELAR/MENU/TIMEOUT from any state)
 * - Invalid transitions (ok: false with mensaje)
 * - Input validation (cantidad <= 0, precio <= 0)
 * - isInactivo() helper
 *
 * States: PREGUNTANDO_PRODUCTO, PREGUNTANDO_CANTIDAD, PREGUNTANDO_UNIDAD,
 *         PREGUNTANDO_COSTO_LOTE, PREGUNTANDO_PRECIO_VENTA, CONFIRMACION_FINAL,
 *         GUARDADO, AGREGANDO_STOCK
 */

import { describe, expect, it } from 'vitest';
import { ConversationState } from '@compras-whatsapp/db';

import {
  INACTIVITY_TIMEOUT_MS,
  isInactivo,
  transition,
  type ConversationEvent,
} from '../../src/interface/whatsapp/conversationStateMachine.ts';
import { InvariantViolationError } from '../../src/domain/errors/ProgrammerError.ts';

const ALL_STATES = Object.values(ConversationState);

describe('conversationStateMachine', () => {
  describe('valid transitions (happy path table)', () => {
    it('PREGUNTANDO_PRODUCTO + PRODUCTO_RECIBIDO → PREGUNTANDO_CANTIDAD / PEDIR_CANTIDAD', () => {
      const r = transition(ConversationState.PREGUNTANDO_PRODUCTO, {
        type: 'PRODUCTO_RECIBIDO',
        valor: 'medias negras',
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_CANTIDAD,
        accion: { tipo: 'PEDIR_CANTIDAD' },
      });
    });

    it('PREGUNTANDO_CANTIDAD + CANTIDAD_RECIBIDA(12) → PREGUNTANDO_UNIDAD / PEDIR_UNIDAD', () => {
      const r = transition(ConversationState.PREGUNTANDO_CANTIDAD, {
        type: 'CANTIDAD_RECIBIDA',
        valor: 12,
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_UNIDAD,
        accion: { tipo: 'PEDIR_UNIDAD' },
      });
    });

    it('PREGUNTANDO_UNIDAD + UNIDAD_RECIBIDA(PAR) → PREGUNTANDO_COSTO_LOTE / PEDIR_COSTO_LOTE', () => {
      const r = transition(ConversationState.PREGUNTANDO_UNIDAD, {
        type: 'UNIDAD_RECIBIDA',
        valor: 'PAR',
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_COSTO_LOTE,
        accion: { tipo: 'PEDIR_COSTO_LOTE' },
      });
    });

    it('PREGUNTANDO_COSTO_LOTE + COSTO_LOTE_RECIBIDO(5000) → PREGUNTANDO_PRECIO_VENTA / PEDIR_PRECIO_VENTA', () => {
      const r = transition(ConversationState.PREGUNTANDO_COSTO_LOTE, {
        type: 'COSTO_LOTE_RECIBIDO',
        valor: 5000,
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRECIO_VENTA,
        accion: { tipo: 'PEDIR_PRECIO_VENTA' },
      });
    });

    it('PREGUNTANDO_PRECIO_VENTA + PRECIO_RECIBIDO(1500) → CONFIRMACION_FINAL / MOSTRAR_RESUMEN', () => {
      const r = transition(ConversationState.PREGUNTANDO_PRECIO_VENTA, {
        type: 'PRECIO_RECIBIDO',
        valor: 1500,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.siguiente).toBe(ConversationState.CONFIRMACION_FINAL);
        expect(r.accion.tipo).toBe('MOSTRAR_RESUMEN');
      }
    });

    it('CONFIRMACION_FINAL + USUARIO_CONFIRMA → GUARDADO / GUARDAR', () => {
      const r = transition(ConversationState.CONFIRMACION_FINAL, { type: 'USUARIO_CONFIRMA' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.GUARDADO,
        accion: { tipo: 'GUARDAR' },
      });
    });

    it('CONFIRMACION_FINAL + USUARIO_RECHAZA → PREGUNTANDO_CANTIDAD / PEDIR_CANTIDAD', () => {
      const r = transition(ConversationState.CONFIRMACION_FINAL, { type: 'USUARIO_RECHAZA' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_CANTIDAD,
        accion: { tipo: 'PEDIR_CANTIDAD' },
      });
    });

    it('GUARDADO + any state-specific event → PREGUNTANDO_PRODUCTO / RESET', () => {
      const r = transition(ConversationState.GUARDADO, {
        type: 'CANTIDAD_RECIBIDA',
        valor: 1,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.siguiente).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
        expect(r.accion.tipo).toBe('RESET');
      }
    });

    it('AGREGANDO_STOCK + SELECCIONAR_PRODUCTO → PREGUNTANDO_CANTIDAD / PEDIR_CANTIDAD', () => {
      const r = transition(ConversationState.AGREGANDO_STOCK, {
        type: 'SELECCIONAR_PRODUCTO',
        indice: 2,
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_CANTIDAD,
        accion: { tipo: 'PEDIR_CANTIDAD' },
      });
    });
  });

  describe('global transitions (any state → PREGUNTANDO_PRODUCTO)', () => {
    for (const state of ALL_STATES) {
      it(`${state} + CANCELAR → PREGUNTANDO_PRODUCTO / RESET with cancel message`, () => {
        const r = transition(state, { type: 'CANCELAR' });
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.siguiente).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
          expect(r.accion.tipo).toBe('RESET');
          if (r.accion.tipo === 'RESET') {
            expect(r.accion.mensaje).toContain('cancelé');
          }
        }
      });

      it(`${state} + MENU → PREGUNTANDO_PRODUCTO / RESET with menu message`, () => {
        const r = transition(state, { type: 'MENU' });
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.siguiente).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
          if (r.accion.tipo === 'RESET') {
            expect(r.accion.mensaje).toContain('Empecemos de nuevo');
          }
        }
      });

      it(`${state} + TIMEOUT → PREGUNTANDO_PRODUCTO / RESET with timeout message`, () => {
        const r = transition(state, { type: 'TIMEOUT' });
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.siguiente).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
          if (r.accion.tipo === 'RESET') {
            expect(r.accion.mensaje).toContain('inactividad');
          }
        }
      });
    }
  });

  describe('invalid transitions (ok: false with mensaje)', () => {
    it('PREGUNTANDO_PRODUCTO + CANTIDAD_RECIBIDA → reject', () => {
      const r = transition(ConversationState.PREGUNTANDO_PRODUCTO, {
        type: 'CANTIDAD_RECIBIDA',
        valor: 1,
      });
      expect(r.ok).toBe(false);
    });

    it('PREGUNTANDO_CANTIDAD + PRECIO_RECIBIDO → reject', () => {
      const r = transition(ConversationState.PREGUNTANDO_CANTIDAD, {
        type: 'PRECIO_RECIBIDO',
        valor: 1500,
      });
      expect(r.ok).toBe(false);
    });

    it('CONFIRMACION_FINAL + PRODUCTO_RECIBIDO → reject', () => {
      const r = transition(ConversationState.CONFIRMACION_FINAL, {
        type: 'PRODUCTO_RECIBIDO',
        valor: 'algo',
      });
      expect(r.ok).toBe(false);
    });
  });

  describe('input validation', () => {
    it('PREGUNTANDO_CANTIDAD + CANTIDAD_RECIBIDA with valor=0 → reject', () => {
      const r = transition(ConversationState.PREGUNTANDO_CANTIDAD, {
        type: 'CANTIDAD_RECIBIDA',
        valor: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.mensaje).toContain('mayor a cero');
      }
    });

    it('PREGUNTANDO_CANTIDAD + CANTIDAD_RECIBIDA with valor=-5 → reject', () => {
      const r = transition(ConversationState.PREGUNTANDO_CANTIDAD, {
        type: 'CANTIDAD_RECIBIDA',
        valor: -5,
      });
      expect(r.ok).toBe(false);
    });

    it('PREGUNTANDO_PRECIO_VENTA + PRECIO_RECIBIDO with valor=0 → reject', () => {
      const r = transition(ConversationState.PREGUNTANDO_PRECIO_VENTA, {
        type: 'PRECIO_RECIBIDO',
        valor: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.mensaje).toContain('mayor a cero');
      }
    });

    it('PREGUNTANDO_PRECIO_VENTA + PRECIO_RECIBIDO with valor=-100 → reject', () => {
      const r = transition(ConversationState.PREGUNTANDO_PRECIO_VENTA, {
        type: 'PRECIO_RECIBIDO',
        valor: -100,
      });
      expect(r.ok).toBe(false);
    });
  });

  describe('exhaustive check (catches new enum values)', () => {
    it('throws InvariantViolationError for an unknown state', () => {
      const fakeState = 'FUTURO_ESTADO' as unknown as ConversationState;
      expect(() =>
        transition(fakeState, { type: 'PRODUCTO_RECIBIDO', valor: 'test' }),
      ).toThrow(InvariantViolationError);
    });
  });

  describe('isInactivo() helper', () => {
    it('returns true when elapsed > INACTIVITY_TIMEOUT_MS', () => {
      const now = 1_700_000_000_000;
      expect(isInactivo(new Date(now - INACTIVITY_TIMEOUT_MS - 1), now)).toBe(true);
    });

    it('returns false when elapsed < INACTIVITY_TIMEOUT_MS', () => {
      const now = 1_700_000_000_000;
      expect(isInactivo(new Date(now - 1000), now)).toBe(false);
    });

    it('boundary: exactly INACTIVITY_TIMEOUT_MS ago is NOT inactive', () => {
      const now = 1_700_000_000_000;
      expect(isInactivo(new Date(now - INACTIVITY_TIMEOUT_MS), now)).toBe(false);
    });
  });

  describe('all state-event combinations are covered', () => {
    it('no (state, event) combo panics unexpectedly', () => {
      const events: ConversationEvent[] = [
        { type: 'PRODUCTO_RECIBIDO', valor: 'test' },
        { type: 'CANTIDAD_RECIBIDA', valor: 1 },
        { type: 'UNIDAD_RECIBIDA', valor: 'UNIDAD' },
        { type: 'COSTO_LOTE_RECIBIDO', valor: 1000 },
        { type: 'PRECIO_RECIBIDO', valor: 1500 },
        { type: 'USUARIO_CONFIRMA' },
        { type: 'USUARIO_RECHAZA' },
        { type: 'SELECCIONAR_PRODUCTO', indice: 0 },
        { type: 'CANCELAR' },
        { type: 'MENU' },
        { type: 'TIMEOUT' },
      ];
      for (const state of ALL_STATES) {
        for (const event of events) {
          // No debe throw — o retorna {ok:true} o {ok:false}
          expect(() => transition(state, event)).not.toThrow();
        }
      }
    });
  });
});
