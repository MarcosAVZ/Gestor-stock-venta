/**
 * Tests for Venta flow transitions in the conversation state machine.
 *
 * Verifies:
 * - PREGUNTANDO_PRODUCTO + VENTA → VENDIENDO_SELECCION (via MENU)
 * - VENDIENDO_SELECCION + SELECCIONAR_PRODUCTO_VENTA → VENDIENDO_CANTIDAD
 * - VENDIENDO_CANTIDAD + CANTIDAD_VENTA_RECIBIDA → VENDIENDO_CONFIRMACION
 * - VENDIENDO_CONFIRMACION + CONFIRMAR_PRECIO_VENTA → GUARDADO
 */

import { describe, expect, it } from 'vitest';
import { ConversationState } from '@compras-whatsapp/db';

import {
  transition,
} from '../../src/interface/whatsapp/conversationStateMachine.ts';

describe('conversationStateMachine — venta flow', () => {
  describe('VENDIENDO_SELECCION transitions', () => {
    it('VENDIENDO_SELECCION + SELECCIONAR_PRODUCTO_VENTA → VENDIENDO_CANTIDAD', () => {
      const r = transition(ConversationState.VENDIENDO_SELECCION, {
        type: 'SELECCIONAR_PRODUCTO_VENTA',
        indice: 0,
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.VENDIENDO_CANTIDAD,
        accion: { tipo: 'PEDIR_CANTIDAD_VENTA' },
      });
    });

    it('VENDIENDO_SELECCION + CANCELAR → PREGUNTANDO_PRODUCTO', () => {
      const r = transition(ConversationState.VENDIENDO_SELECCION, { type: 'CANCELAR' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.siguiente).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
      }
    });
  });

  describe('VENDIENDO_CANTIDAD transitions', () => {
    it('VENDIENDO_CANTIDAD + CANTIDAD_VENTA_RECIBIDA(5) → VENDIENDO_CONFIRMACION', () => {
      const r = transition(ConversationState.VENDIENDO_CANTIDAD, {
        type: 'CANTIDAD_VENTA_RECIBIDA',
        valor: 5,
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.VENDIENDO_CONFIRMACION,
        accion: { tipo: 'MOSTRAR_RESUMEN_VENTA', resumen: 'ok' },
      });
    });

    it('VENDIENDO_CANTIDAD + CANTIDAD_VENTA_RECIBIDA(0) → reject', () => {
      const r = transition(ConversationState.VENDIENDO_CANTIDAD, {
        type: 'CANTIDAD_VENTA_RECIBIDA',
        valor: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.mensaje).toContain('mayor a cero');
      }
    });
  });

  describe('VENDIENDO_CONFIRMACION transitions', () => {
    it('VENDIENDO_CONFIRMACION + CONFIRMAR_PRECIO_VENTA → GUARDADO', () => {
      const r = transition(ConversationState.VENDIENDO_CONFIRMACION, {
        type: 'CONFIRMAR_PRECIO_VENTA',
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.GUARDADO,
        accion: { tipo: 'GUARDAR_VENTA' },
      });
    });

    it('VENDIENDO_CONFIRMACION + USUARIO_RECHAZA → VENDIENDO_CANTIDAD', () => {
      const r = transition(ConversationState.VENDIENDO_CONFIRMACION, {
        type: 'USUARIO_RECHAZA',
      });
      expect(r).toEqual({
        ok: true,
        siguiente: ConversationState.VENDIENDO_CANTIDAD,
        accion: { tipo: 'PEDIR_CANTIDAD_VENTA' },
      });
    });
  });

  describe('VENDIENDO_* global transitions', () => {
    it('VENDIENDO_SELECCION + CANCELAR → PREGUNTANDO_PRODUCTO', () => {
      const r = transition(ConversationState.VENDIENDO_SELECCION, { type: 'CANCELAR' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.siguiente).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
    });

    it('VENDIENDO_CANTIDAD + CANCELAR → PREGUNTANDO_PRODUCTO', () => {
      const r = transition(ConversationState.VENDIENDO_CANTIDAD, { type: 'CANCELAR' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.siguiente).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
    });

    it('VENDIENDO_CONFIRMACION + CANCELAR → PREGUNTANDO_PRODUCTO', () => {
      const r = transition(ConversationState.VENDIENDO_CONFIRMACION, { type: 'CANCELAR' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.siguiente).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
    });
  });
});
