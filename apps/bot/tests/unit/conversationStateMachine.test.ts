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

/** Estados que la state machine conoce actualmente (todos). */
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

    it('AGREGANDO_STOCK + SELECCIONAR_PRODUCTO → PREGUNTANDO_CANTIDAD_AGREGAR / PEDIR_CANTIDAD', () => {
      const r = transition(ConversationState.AGREGANDO_STOCK, {
        type: 'SELECCIONAR_PRODUCTO',
        indice: 2,
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_CANTIDAD_AGREGAR,
        accion: { tipo: 'PEDIR_CANTIDAD' },
      });
    });

    it('PREGUNTANDO_CANTIDAD_AGREGAR + CANTIDAD_AGREGAR_RECIBIDA(12) → PREGUNTANDO_COSTO_LOTE_AGREGAR / PEDIR_COSTO_LOTE_AGREGAR', () => {
      const r = transition(ConversationState.PREGUNTANDO_CANTIDAD_AGREGAR, {
        type: 'CANTIDAD_AGREGAR_RECIBIDA',
        valor: 12,
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_COSTO_LOTE_AGREGAR,
        accion: { tipo: 'PEDIR_COSTO_LOTE_AGREGAR' },
      });
    });

    it('PREGUNTANDO_COSTO_LOTE_AGREGAR + COSTO_LOTE_AGREGAR_RECIBIDO(5000) → PREGUNTANDO_PRECIO_VENTA / PEDIR_PRECIO_VENTA', () => {
      const r = transition(ConversationState.PREGUNTANDO_COSTO_LOTE_AGREGAR, {
        type: 'COSTO_LOTE_AGREGAR_RECIBIDO',
        valor: 5000,
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRECIO_VENTA,
        accion: { tipo: 'PEDIR_PRECIO_VENTA' },
      });
    });

    it('PREGUNTANDO_CANTIDAD_AGREGAR + CANTIDAD_AGREGAR_RECIBIDA(0) → reject (must be > 0)', () => {
      const r = transition(ConversationState.PREGUNTANDO_CANTIDAD_AGREGAR, {
        type: 'CANTIDAD_AGREGAR_RECIBIDA',
        valor: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.mensaje).toContain('mayor a cero');
      }
    });

    it('PREGUNTANDO_COSTO_LOTE_AGREGAR + COSTO_LOTE_AGREGAR_RECIBIDO(0) → reject (must be > 0)', () => {
      const r = transition(ConversationState.PREGUNTANDO_COSTO_LOTE_AGREGAR, {
        type: 'COSTO_LOTE_AGREGAR_RECIBIDO',
        valor: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.mensaje).toContain('mayor a cero');
      }
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

  describe('ASIGNANDO_GRUPO state', () => {
    it('ASIGNANDO_GRUPO + NOMBRE_GRUPO_RECIBIDO → PREGUNTANDO_PRODUCTO / GUARDAR_GRUPO', () => {
      const r = transition(ConversationState.ASIGNANDO_GRUPO, {
        type: 'NOMBRE_GRUPO_RECIBIDO',
        valor: 'lácteos',
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRODUCTO,
        accion: { tipo: 'GUARDAR_GRUPO' },
      });
    });

    it('ASIGNANDO_GRUPO + CANCELAR → PREGUNTANDO_PRODUCTO', () => {
      const r = transition(ConversationState.ASIGNANDO_GRUPO, { type: 'CANCELAR' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRODUCTO,
        accion: { tipo: 'RESET', mensaje: 'Listo, cancelé. Empecemos de nuevo.' },
      });
    });

    it('ASIGNANDO_GRUPO + MENU → PREGUNTANDO_PRODUCTO', () => {
      const r = transition(ConversationState.ASIGNANDO_GRUPO, { type: 'MENU' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRODUCTO,
        accion: { tipo: 'RESET', mensaje: 'Empecemos de nuevo. Decime: nueva, agregar, ayuda, etc.' },
      });
    });

    it('ASIGNANDO_GRUPO + TIMEOUT → PREGUNTANDO_PRODUCTO', () => {
      const r = transition(ConversationState.ASIGNANDO_GRUPO, { type: 'TIMEOUT' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRODUCTO,
        accion: { tipo: 'RESET', mensaje: 'Tu sesión se cerró por inactividad. Mandame un mensaje nuevo.' },
      });
    });

    it('ASIGNANDO_GRUPO + PRODUCTO_RECIBIDO → ok: false', () => {
      const r = transition(ConversationState.ASIGNANDO_GRUPO, {
        type: 'PRODUCTO_RECIBIDO',
        valor: 'test',
      });
      expect(r.ok).toBe(false);
    });
  });

  describe('IMPORTANDO_ESPERANDO_ARCHIVO state', () => {
    it('PREGUNTANDO_PRODUCTO + IMPORTAR_INICIAR → IMPORTANDO_ESPERANDO_ARCHIVO', () => {
      const r = transition(ConversationState.PREGUNTANDO_PRODUCTO, { type: 'IMPORTAR_INICIAR' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO,
        accion: { tipo: 'PEDIR_ARCHIVO' },
      });
    });

    it('IMPORTANDO_ESPERANDO_ARCHIVO + DOCUMENTO_RECIBIDO → IMPORTANDO_REVISANDO', () => {
      const r = transition(ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO, { type: 'DOCUMENTO_RECIBIDO' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.IMPORTANDO_REVISANDO,
        accion: { tipo: 'MOSTRAR_DIFF' },
      });
    });

    it('IMPORTANDO_ESPERANDO_ARCHIVO + CANCELAR → PREGUNTANDO_PRODUCTO', () => {
      const r = transition(ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO, { type: 'CANCELAR' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRODUCTO,
        accion: { tipo: 'RESET', mensaje: 'Listo, cancelé. Empecemos de nuevo.' },
      });
    });

    it('IMPORTANDO_ESPERANDO_ARCHIVO + MENU → PREGUNTANDO_PRODUCTO', () => {
      const r = transition(ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO, { type: 'MENU' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRODUCTO,
        accion: { tipo: 'RESET', mensaje: 'Empecemos de nuevo. Decime: nueva, agregar, ayuda, etc.' },
      });
    });

    it('IMPORTANDO_ESPERANDO_ARCHIVO + TIMEOUT → PREGUNTANDO_PRODUCTO', () => {
      const r = transition(ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO, { type: 'TIMEOUT' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRODUCTO,
        accion: { tipo: 'RESET', mensaje: 'Tu sesión se cerró por inactividad. Mandame un mensaje nuevo.' },
      });
    });

    it('IMPORTANDO_ESPERANDO_ARCHIVO + PRODUCTO_RECIBIDO → ok: false', () => {
      const r = transition(ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO, {
        type: 'PRODUCTO_RECIBIDO',
        valor: 'test',
      });
      expect(r.ok).toBe(false);
    });
  });

  describe('IMPORTANDO_REVISANDO state', () => {
    it('IMPORTANDO_REVISANDO + CONFIRMAR_IMPORT → PREGUNTANDO_PRODUCTO / APLICAR_IMPORT', () => {
      const r = transition(ConversationState.IMPORTANDO_REVISANDO, { type: 'CONFIRMAR_IMPORT' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRODUCTO,
        accion: { tipo: 'APLICAR_IMPORT' },
      });
    });

    it('IMPORTANDO_REVISANDO + CANCELAR_IMPORT → PREGUNTANDO_PRODUCTO / RESET', () => {
      const r = transition(ConversationState.IMPORTANDO_REVISANDO, { type: 'CANCELAR_IMPORT' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRODUCTO,
        accion: { tipo: 'RESET', mensaje: 'Ok, importación cancelada.' },
      });
    });

    it('IMPORTANDO_REVISANDO + DOCUMENTO_RECIBIDO → IMPORTANDO_REVISANDO / MOSTRAR_DIFF (re-file)', () => {
      const r = transition(ConversationState.IMPORTANDO_REVISANDO, { type: 'DOCUMENTO_RECIBIDO' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.IMPORTANDO_REVISANDO,
        accion: { tipo: 'MOSTRAR_DIFF' },
      });
    });

    it('IMPORTANDO_REVISANDO + CANCELAR → PREGUNTANDO_PRODUCTO', () => {
      const r = transition(ConversationState.IMPORTANDO_REVISANDO, { type: 'CANCELAR' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRODUCTO,
        accion: { tipo: 'RESET', mensaje: 'Listo, cancelé. Empecemos de nuevo.' },
      });
    });

    it('IMPORTANDO_REVISANDO + MENU → PREGUNTANDO_PRODUCTO', () => {
      const r = transition(ConversationState.IMPORTANDO_REVISANDO, { type: 'MENU' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRODUCTO,
        accion: { tipo: 'RESET', mensaje: 'Empecemos de nuevo. Decime: nueva, agregar, ayuda, etc.' },
      });
    });

    it('IMPORTANDO_REVISANDO + TIMEOUT → PREGUNTANDO_PRODUCTO', () => {
      const r = transition(ConversationState.IMPORTANDO_REVISANDO, { type: 'TIMEOUT' });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.PREGUNTANDO_PRODUCTO,
        accion: { tipo: 'RESET', mensaje: 'Tu sesión se cerró por inactividad. Mandame un mensaje nuevo.' },
      });
    });

    it('IMPORTANDO_REVISANDO + PRODUCTO_RECIBIDO → ok: false', () => {
      const r = transition(ConversationState.IMPORTANDO_REVISANDO, {
        type: 'PRODUCTO_RECIBIDO',
        valor: 'test',
      });
      expect(r.ok).toBe(false);
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
        { type: 'SELECCIONAR_PRODUCTO_VENTA', indice: 0 },
        { type: 'CANTIDAD_VENTA_RECIBIDA', valor: 1 },
        { type: 'CONFIRMAR_PRECIO_VENTA' },
        { type: 'COSTO_LOTE_AGREGAR_RECIBIDO', valor: 1000 },
        { type: 'CANTIDAD_AGREGAR_RECIBIDA', valor: 1 },
        { type: 'NOMBRE_GRUPO_RECIBIDO', valor: 'lácteos' },
        { type: 'IMPORTAR_INICIAR' },
        { type: 'DOCUMENTO_RECIBIDO' },
        { type: 'CONFIRMAR_IMPORT' },
        { type: 'CANCELAR_IMPORT' },
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
