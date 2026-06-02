/**
 * Tests del ConversationStateMachine.
 *
 * Cubre:
 * - TODAS las transiciones válidas (tabla de 8 transiciones state-specific
 *   + 3 globales CANCELAR/MENU/TIMEOUT).
 * - Transiciones inválidas: cada estado con cada evento no-aplicable
 *   debe retornar `{ ok: false, mensaje }` con texto voseo.
 * - Learning skip (PR5): USUARIO_CONFIRMA en VALIDANDO_DATOS con
 *   cantidadSugerida + unidadSugerida salta a PREGUNTANDO_PRECIO_VENTA.
 * - Validación de input: CANTIDAD_RECIBIDA <= 0 → reject;
 *   PRECIO_RECIBIDO <= 0 → reject.
 * - Exhaustive check: estados desconocidos lanzan InvariantViolationError.
 * - isInactivo() helper.
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
    it('ESPERANDO_IMAGEN + IMAGEN_RECIBIDA → VALIDANDO_DATOS / DISPARAR_OCR', () => {
      const r = transition(ConversationState.ESPERANDO_IMAGEN, { type: 'IMAGEN_RECIBIDA' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.VALIDANDO_DATOS,
        accion: { tipo: 'DISPARAR_OCR' },
      });
    });

    it('VALIDANDO_DATOS + USUARIO_CONFIRMA → PREGUNTANDO_CANTIDAD / PEDIR_CANTIDAD', () => {
      const r = transition(ConversationState.VALIDANDO_DATOS, { type: 'USUARIO_CONFIRMA' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_CANTIDAD,
        accion: { tipo: 'PEDIR_CANTIDAD' },
      });
    });

    it('VALIDANDO_DATOS + USUARIO_RECHAZA → VALIDANDO_DATOS / PEDIR_CONFIRMACION', () => {
      const r = transition(
        ConversationState.VALIDANDO_DATOS,
        { type: 'USUARIO_RECHAZA' },
        { productoDetectado: 'medias negras', costoLoteDetectado: 1500 },
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.siguiente).toBe(ConversationState.VALIDANDO_DATOS);
        expect(r.accion.tipo).toBe('PEDIR_CONFIRMACION');
      }
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

    it('PREGUNTANDO_UNIDAD + UNIDAD_RECIBIDA(PAR) → PREGUNTANDO_PRECIO_VENTA', () => {
      const r = transition(ConversationState.PREGUNTANDO_UNIDAD, {
        type: 'UNIDAD_RECIBIDA',
        valor: 'PAR',
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

    it('GUARDADO + (cualquier evento state-specific) → ESPERANDO_IMAGEN / RESET', () => {
      // GUARDADO es transitorio: cualquier evento state-specific vuelve
      // a ESPERANDO_IMAGEN con mensaje de "mandame la próxima".
      const r = transition(ConversationState.GUARDADO, {
        type: 'CANTIDAD_RECIBIDA',
        valor: 1,
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.ESPERANDO_IMAGEN,
        accion: { tipo: 'RESET', mensaje: 'Mandame la próxima imagen cuando quieras.' },
      });
    });
  });

  describe('global transitions (any state → ESPERANDO_IMAGEN)', () => {
    for (const state of ALL_STATES) {
      it(`${state} + CANCELAR → ESPERANDO_IMAGEN`, () => {
        const r = transition(state, { type: 'CANCELAR' });
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.siguiente).toBe(ConversationState.ESPERANDO_IMAGEN);
          expect(r.accion.tipo).toBe('RESET');
          if (r.accion.tipo === 'RESET') {
            expect(r.accion.mensaje).toContain('cancelé');
          }
        }
      });

      it(`${state} + MENU → ESPERANDO_IMAGEN`, () => {
        const r = transition(state, { type: 'MENU' });
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.siguiente).toBe(ConversationState.ESPERANDO_IMAGEN);
          if (r.accion.tipo === 'RESET') {
            expect(r.accion.mensaje).toContain('Empecemos de nuevo');
          }
        }
      });

      it(`${state} + TIMEOUT → ESPERANDO_IMAGEN`, () => {
        const r = transition(state, { type: 'TIMEOUT' });
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.siguiente).toBe(ConversationState.ESPERANDO_IMAGEN);
          if (r.accion.tipo === 'RESET') {
            expect(r.accion.mensaje).toContain('inactividad');
          }
        }
      });
    }
  });

  describe('invalid transitions (ok: false with mensaje)', () => {
    it('ESPERANDO_IMAGEN + texto (USUARIO_CONFIRMA) → reject with hint', () => {
      const r = transition(ConversationState.ESPERANDO_IMAGEN, { type: 'USUARIO_CONFIRMA' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.mensaje).toMatch(/no esperaba|No entendí/);
        expect(r.mensaje).toContain('cancelar');
      }
    });

    it('VALIDANDO_DATOS + IMAGEN_RECIBIDA → reject', () => {
      const r = transition(ConversationState.VALIDANDO_DATOS, { type: 'IMAGEN_RECIBIDA' });
      expect(r.ok).toBe(false);
    });

    it('PREGUNTANDO_CANTIDAD + USUARIO_CONFIRMA → reject with "esperaba un número"', () => {
      const r = transition(ConversationState.PREGUNTANDO_CANTIDAD, {
        type: 'USUARIO_CONFIRMA',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.mensaje).toContain('esperaba un número');
      }
    });

    it('PREGUNTANDO_UNIDAD + CANTIDAD_RECIBIDA → reject', () => {
      const r = transition(ConversationState.PREGUNTANDO_UNIDAD, {
        type: 'CANTIDAD_RECIBIDA',
        valor: 1,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.mensaje).toContain('unidad');
      }
    });

    it('PREGUNTANDO_PRECIO_VENTA + UNIDAD_RECIBIDA → reject', () => {
      const r = transition(ConversationState.PREGUNTANDO_PRECIO_VENTA, {
        type: 'UNIDAD_RECIBIDA',
        valor: 'UNIDAD',
      });
      expect(r.ok).toBe(false);
    });

    it('CONFIRMACION_FINAL + IMAGEN_RECIBIDA → reject', () => {
      const r = transition(ConversationState.CONFIRMACION_FINAL, { type: 'IMAGEN_RECIBIDA' });
      expect(r.ok).toBe(false);
    });
  });

  describe('input validation', () => {
    it('CANTIDAD_RECIBIDA with valor=0 → reject with friendly message', () => {
      const r = transition(ConversationState.PREGUNTANDO_CANTIDAD, {
        type: 'CANTIDAD_RECIBIDA',
        valor: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.mensaje).toContain('mayor a cero');
      }
    });

    it('CANTIDAD_RECIBIDA with valor=-5 → reject', () => {
      const r = transition(ConversationState.PREGUNTANDO_CANTIDAD, {
        type: 'CANTIDAD_RECIBIDA',
        valor: -5,
      });
      expect(r.ok).toBe(false);
    });

    it('PRECIO_RECIBIDO with valor=0 → reject', () => {
      const r = transition(ConversationState.PREGUNTANDO_PRECIO_VENTA, {
        type: 'PRECIO_RECIBIDO',
        valor: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.mensaje).toContain('mayor a cero');
      }
    });

    it('VALIDANDO_DATOS + USUARIO_RECHAZA sin productoDetectado → reject (no data)', () => {
      const r = transition(ConversationState.VALIDANDO_DATOS, { type: 'USUARIO_RECHAZA' });
      expect(r.ok).toBe(false);
    });
  });

  describe('learning skip (PR5 forward-compat)', () => {
    it('VALIDANDO_DATOS + USUARIO_CONFIRMA with cantidadSugerida + unidadSugerida → PREGUNTANDO_PRECIO_VENTA (skip cantidad/unidad)', () => {
      const r = transition(
        ConversationState.VALIDANDO_DATOS,
        { type: 'USUARIO_CONFIRMA' },
        { cantidadSugerida: 12, unidadSugerida: 'PAR' },
      );
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRECIO_VENTA,
        accion: { tipo: 'PEDIR_PRECIO_VENTA' },
      });
    });

    it('VALIDANDO_DATOS + USUARIO_CONFIRMA with ONLY cantidadSugerida → PREGUNTANDO_CANTIDAD (no skip)', () => {
      const r = transition(
        ConversationState.VALIDANDO_DATOS,
        { type: 'USUARIO_CONFIRMA' },
        { cantidadSugerida: 12 }, // no unidadSugerida
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.siguiente).toBe(ConversationState.PREGUNTANDO_CANTIDAD);
      }
    });
  });

  describe('exhaustive check (catches new enum values)', () => {
    it('throws InvariantViolationError for an unknown state', () => {
      // Cast para forzar el exhaustive check a fallar. Usamos un
      // evento STATE-SPECIFIC (no global) para que el código entre
      // al switch y llegue al default branch.
      const fakeState = 'FUTURO_ESTADO' as unknown as ConversationState;
      expect(() => transition(fakeState, { type: 'IMAGEN_RECIBIDA' })).toThrow(
        InvariantViolationError,
      );
    });
  });

  describe('isInactivo() helper', () => {
    it('returns false when updatedAt is fresh', () => {
      const now = 1_700_000_000_000;
      expect(isInactivo(new Date(now - 1000), now)).toBe(false);
    });

    it('returns true when updatedAt is older than INACTIVITY_TIMEOUT_MS', () => {
      const now = 1_700_000_000_000;
      expect(isInactivo(new Date(now - INACTIVITY_TIMEOUT_MS - 1), now)).toBe(true);
    });

    it('boundary: exactly INACTIVITY_TIMEOUT_MS ago is NOT inactive', () => {
      const now = 1_700_000_000_000;
      expect(isInactivo(new Date(now - INACTIVITY_TIMEOUT_MS), now)).toBe(false);
    });
  });

  describe('USUARIO_CORRIGE action (PEDIR_CONFIRMACION with campo)', () => {
    it('VALIDANDO_DATOS + USUARIO_CORRIGE → VALIDANDO_DATOS with PEDIR_CONFIRMACION', () => {
      const r = transition(
        ConversationState.VALIDANDO_DATOS,
        { type: 'USUARIO_CORRIGE', campo: 'producto' },
        { productoDetectado: 'medias negras', costoLoteDetectado: 1500 },
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.siguiente).toBe(ConversationState.VALIDANDO_DATOS);
        if (r.accion.tipo === 'PEDIR_CONFIRMACION') {
          expect(r.accion.producto).toBe('medias negras');
          expect(r.accion.costoLote).toBe(1500);
        }
      }
    });
  });

  describe('all state-event combinations are covered', () => {
    it('no (state, event) combo panics unexpectedly', () => {
      const events: ConversationEvent[] = [
        { type: 'IMAGEN_RECIBIDA' },
        { type: 'USUARIO_CONFIRMA' },
        { type: 'USUARIO_RECHAZA' },
        { type: 'USUARIO_CORRIGE', campo: 'x' },
        { type: 'CANTIDAD_RECIBIDA', valor: 1 },
        { type: 'UNIDAD_RECIBIDA', valor: 'UNIDAD' },
        { type: 'PRECIO_RECIBIDO', valor: 1 },
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
