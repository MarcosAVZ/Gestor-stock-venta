/**
 * Tests unitarios para inputMapper (pure function — TDD RED→GREEN→REFACTOR).
 *
 * Verifica que inputToEvent mapea correctamente texto de usuario a
 * ConversationEvent según el estado actual de la conversación.
 */
import { describe, expect, it } from 'vitest';
import { ConversationState } from '@compras-whatsapp/db';

import { inputToEvent } from '../../../src/application/handlers/inputMapper.ts';

function makeInput(body: string) {
  return { phone: '+5491111111111', type: 'text' as const, body };
}

describe('inputMapper — inputToEvent', () => {
  // ── Global commands ──────────────────────────────────────────────

  describe('global commands (any state)', () => {
    it('"cancelar" returns CANCELAR event', () => {
      const result = inputToEvent(makeInput('cancelar'), ConversationState.PREGUNTANDO_CANTIDAD, {});
      expect(result).toEqual({ event: { type: 'CANCELAR' }, datosPatch: {} });
    });

    it('"cancel" also works', () => {
      const result = inputToEvent(makeInput('cancel'), ConversationState.PREGUNTANDO_UNIDAD, {});
      expect(result?.event.type).toBe('CANCELAR');
    });

    it('"menu" returns MENU event', () => {
      const result = inputToEvent(makeInput('menu'), ConversationState.CONFIRMACION_FINAL, {});
      expect(result).toEqual({ event: { type: 'MENU' }, datosPatch: {} });
    });

    it('"empezar" returns MENU event', () => {
      const result = inputToEvent(makeInput('empezar'), ConversationState.EDITANDO_VALOR, {});
      expect(result?.event.type).toBe('MENU');
    });
  });

  // ── PREGUNTANDO_PRODUCTO ────────────────────────────────────────

  describe('PREGUNTANDO_PRODUCTO', () => {
    it('any text returns PRODUCTO_RECIBIDO', () => {
      const result = inputToEvent(makeInput('medias negras'), ConversationState.PREGUNTANDO_PRODUCTO, {});
      expect(result).toEqual({
        event: { type: 'PRODUCTO_RECIBIDO', valor: 'medias negras' },
        datosPatch: { producto: 'medias negras' },
      });
    });

    it('trims whitespace', () => {
      const result = inputToEvent(makeInput('  gorras  '), ConversationState.PREGUNTANDO_PRODUCTO, {});
      expect(result?.event).toEqual({ type: 'PRODUCTO_RECIBIDO', valor: 'gorras' });
    });
  });

  // ── SI/NO ────────────────────────────────────────────────────────

  describe('yes/no answers', () => {
    it('"sí" returns USUARIO_CONFIRMA', () => {
      const result = inputToEvent(makeInput('sí'), ConversationState.CONFIRMACION_FINAL, {});
      expect(result?.event.type).toBe('USUARIO_CONFIRMA');
    });

    it('"si" returns USUARIO_CONFIRMA', () => {
      const result = inputToEvent(makeInput('si'), ConversationState.CONFIRMACION_FINAL, {});
      expect(result?.event.type).toBe('USUARIO_CONFIRMA');
    });

    it('"no" returns USUARIO_RECHAZA', () => {
      const result = inputToEvent(makeInput('no'), ConversationState.CONFIRMACION_FINAL, {});
      expect(result?.event.type).toBe('USUARIO_RECHAZA');
    });
  });

  // ── PREGUNTANDO_CANTIDAD ────────────────────────────────────────

  describe('PREGUNTANDO_CANTIDAD', () => {
    it('"12" returns CANTIDAD_RECIBIDA with number', () => {
      const result = inputToEvent(makeInput('12'), ConversationState.PREGUNTANDO_CANTIDAD, {});
      expect(result).toEqual({
        event: { type: 'CANTIDAD_RECIBIDA', valor: 12 },
        datosPatch: { cantidadIngresada: 12 },
      });
    });

    it('"abc" returns null (not a number)', () => {
      const result = inputToEvent(makeInput('abc'), ConversationState.PREGUNTANDO_CANTIDAD, {});
      expect(result).toBeNull();
    });
  });

  // ── PREGUNTANDO_UNIDAD ──────────────────────────────────────────

  describe('PREGUNTANDO_UNIDAD', () => {
    it('"unidad" returns UNIDAD_RECIBIDA', () => {
      const result = inputToEvent(makeInput('unidad'), ConversationState.PREGUNTANDO_UNIDAD, {});
      expect(result?.event.type).toBe('UNIDAD_RECIBIDA');
    });

    it('"par" returns UNIDAD_RECIBIDA', () => {
      const result = inputToEvent(makeInput('par'), ConversationState.PREGUNTANDO_UNIDAD, {});
      expect(result?.event.type).toBe('UNIDAD_RECIBIDA');
    });

    it('"xyz" returns null (invalid unit)', () => {
      const result = inputToEvent(makeInput('xyz'), ConversationState.PREGUNTANDO_UNIDAD, {});
      expect(result).toBeNull();
    });
  });

  // ── PREGUNTANDO_COSTO_LOTE ─────────────────────────────────────

  describe('PREGUNTANDO_COSTO_LOTE', () => {
    it('"1500" returns COSTO_LOTE_RECIBIDO', () => {
      const result = inputToEvent(makeInput('1500'), ConversationState.PREGUNTANDO_COSTO_LOTE, {});
      expect(result?.event.type).toBe('COSTO_LOTE_RECIBIDO');
    });

    it('"abc" returns null', () => {
      const result = inputToEvent(makeInput('abc'), ConversationState.PREGUNTANDO_COSTO_LOTE, {});
      expect(result).toBeNull();
    });
  });

  // ── PREGUNTANDO_PRECIO_VENTA ────────────────────────────────────

  describe('PREGUNTANDO_PRECIO_VENTA', () => {
    it('"2500" returns PRECIO_RECIBIDO', () => {
      const result = inputToEvent(makeInput('2500'), ConversationState.PREGUNTANDO_PRECIO_VENTA, {});
      expect(result?.event.type).toBe('PRECIO_RECIBIDO');
    });
  });

  // ── AGREGANDO_STOCK ─────────────────────────────────────────────

  describe('AGREGANDO_STOCK', () => {
    it('"1" returns SELECCIONAR_PRODUCTO with indice 1', () => {
      const result = inputToEvent(makeInput('1'), ConversationState.AGREGANDO_STOCK, {});
      expect(result).toEqual({
        event: { type: 'SELECCIONAR_PRODUCTO', indice: 1 },
        datosPatch: { productoIndice: 1 },
      });
    });

    it('"abc" returns null (not a number)', () => {
      const result = inputToEvent(makeInput('abc'), ConversationState.AGREGANDO_STOCK, {});
      expect(result).toBeNull();
    });

    it('"0" returns null (must be > 0)', () => {
      const result = inputToEvent(makeInput('0'), ConversationState.AGREGANDO_STOCK, {});
      expect(result).toBeNull();
    });
  });

  // ── EDITANDO_SELECCION ──────────────────────────────────────────

  describe('EDITANDO_SELECCION', () => {
    it('"1" returns SELECCIONAR_CAMPO with campo "1"', () => {
      const result = inputToEvent(makeInput('1'), ConversationState.EDITANDO_SELECCION, {});
      expect(result).toEqual({
        event: { type: 'SELECCIONAR_CAMPO', campo: '1' },
        datosPatch: { campoEditando: '1' },
      });
    });

    it('"6" returns null (must be 1-5)', () => {
      const result = inputToEvent(makeInput('6'), ConversationState.EDITANDO_SELECCION, {});
      expect(result).toBeNull();
    });
  });

  // ── EDITANDO_VALOR ──────────────────────────────────────────────

  describe('EDITANDO_VALOR', () => {
    it('text field returns VALOR_EDITADO with raw text', () => {
      const result = inputToEvent(
        makeInput('nuevo nombre'),
        ConversationState.EDITANDO_VALOR,
        { campoEditando: '1' },
      );
      expect(result).toEqual({
        event: { type: 'VALOR_EDITADO', valor: 'nuevo nombre' },
        datosPatch: {},
      });
    });

    it('numeric field (campo 2) parses number', () => {
      const result = inputToEvent(
        makeInput('24'),
        ConversationState.EDITANDO_VALOR,
        { campoEditando: '2' },
      );
      expect(result?.event.type).toBe('VALOR_EDITADO');
    });

    it('empty text returns null', () => {
      const result = inputToEvent(
        makeInput(''),
        ConversationState.EDITANDO_VALOR,
        { campoEditando: '1' },
      );
      expect(result).toBeNull();
    });
  });

  // ── null mapping ────────────────────────────────────────────────

  describe('unmapped input', () => {
    it('returns null for non-numeric text in PREGUNTANDO_CANTIDAD', () => {
      const result = inputToEvent(makeInput('foobar'), ConversationState.PREGUNTANDO_CANTIDAD, {});
      expect(result).toBeNull();
    });

    it('returns null for non-numeric text in AGREGANDO_STOCK', () => {
      const result = inputToEvent(makeInput('foobar'), ConversationState.AGREGANDO_STOCK, {});
      expect(result).toBeNull();
    });
  });
});
