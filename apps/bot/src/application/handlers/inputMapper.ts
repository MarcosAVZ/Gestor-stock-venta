/**
 * @compras-whatsapp/bot — inputMapper (pure function).
 *
 * Extracted from HandleIncomingMessage.ts — maps user input text to a
 * ConversationEvent based on the current conversational state.
 *
 * Why separate:
 * - Pure function: no DB, no side effects, trivially testable.
 * - ~120 lines of state-dependent parsing logic that bloats the orchestrator.
 * - Single responsibility: text → event mapping.
 *
 * States handled:
 * - Global: cancelar, menu
 * - PREGUNTANDO_PRODUCTO: any text → PRODUCTO_RECIBIDO
 * - CONFIRMACION_FINAL / ELIMINANDO_PRODUCTOS: sí/no
 * - PREGUNTANDO_CANTIDAD: number
 * - PREGUNTANDO_UNIDAD: unidad/par/pack/caja/otro
 * - PREGUNTANDO_COSTO_LOTE: price
 * - PREGUNTANDO_PRECIO_VENTA: price
 * - AGREGANDO_STOCK: index number
 * - EDITANDO_SELECCION: 1-5
 * - EDITANDO_VALOR: text (with numeric parse for numeric fields)
 */

import { ConversationState } from '@compras-whatsapp/db';

import {
  cantidadSchema,
  opcionSiNoSchema,
  opcionUnidadSchema,
  precioSchema,
} from '@compras-whatsapp/shared';

import type { ConversationEvent } from '../../interface/whatsapp/conversationStateMachine.ts';

export type IncomingMessageInput = { phone: string; type: 'text'; body: string };

export type InputMapping = {
  event: ConversationEvent;
  datosPatch: Record<string, unknown>;
};

/**
 * Maps user input to a ConversationEvent for the current state.
 * Returns null if input doesn't match any event for the state.
 */
export function inputToEvent(
  input: IncomingMessageInput,
  state: ConversationState,
  datos: Record<string, unknown>,
): InputMapping | null {
  const text = input.body.trim();
  const lower = text.toLowerCase();

  // Global commands available from any state
  if (lower === 'cancelar' || lower === 'cancel') return { event: { type: 'CANCELAR' }, datosPatch: {} };
  if (lower === 'menu' || lower === 'menú' || lower === 'empezar') return { event: { type: 'MENU' }, datosPatch: {} };

  // PREGUNTANDO_PRODUCTO: any text → PRODUCTO_RECIBIDO
  if (state === ConversationState.PREGUNTANDO_PRODUCTO) {
    if (text.length > 0) {
      return {
        event: { type: 'PRODUCTO_RECIBIDO', valor: text.toLowerCase() },
        datosPatch: { producto: text.toLowerCase() },
      };
    }
  }

  // State-specific handlers BEFORE yes/no to avoid "1" → "si" conflicts
  // PREGUNTANDO_CANTIDAD: number → CANTIDAD_RECIBIDA
  if (state === ConversationState.PREGUNTANDO_CANTIDAD) {
    const parsed = cantidadSchema.safeParse(Number(text));
    if (parsed.success) {
      return {
        event: { type: 'CANTIDAD_RECIBIDA', valor: parsed.data },
        datosPatch: { cantidadIngresada: parsed.data },
      };
    }
  }

  // PREGUNTANDO_UNIDAD: text → UNIDAD_RECIBIDA
  if (state === ConversationState.PREGUNTANDO_UNIDAD) {
    const parsed = opcionUnidadSchema.safeParse(lower);
    if (parsed.success) {
      return {
        event: { type: 'UNIDAD_RECIBIDA', valor: parsed.data },
        datosPatch: { unidadIngresada: parsed.data },
      };
    }
  }

  // PREGUNTANDO_COSTO_LOTE: number → COSTO_LOTE_RECIBIDO
  if (state === ConversationState.PREGUNTANDO_COSTO_LOTE) {
    const parsed = precioSchema.safeParse(text);
    if (parsed.success) {
      return {
        event: { type: 'COSTO_LOTE_RECIBIDO', valor: parsed.data },
        datosPatch: { costoLote: parsed.data },
      };
    }
  }

  // PREGUNTANDO_PRECIO_VENTA: number → PRECIO_RECIBIDO
  if (state === ConversationState.PREGUNTANDO_PRECIO_VENTA) {
    const parsed = precioSchema.safeParse(text);
    if (parsed.success) {
      return {
        event: { type: 'PRECIO_RECIBIDO', valor: parsed.data },
        datosPatch: { precioVenta: parsed.data },
      };
    }
  }

  // AGREGANDO_STOCK: number → SELECCIONAR_PRODUCTO
  if (state === ConversationState.AGREGANDO_STOCK) {
    const num = Number(text);
    if (!isNaN(num) && num > 0 && Number.isInteger(num)) {
      return {
        event: { type: 'SELECCIONAR_PRODUCTO', indice: num },
        datosPatch: { productoIndice: num },
      };
    }
  }

  // EDITANDO_SELECCION: number → SELECCIONAR_CAMPO
  if (state === ConversationState.EDITANDO_SELECCION) {
    const num = Number(text);
    if (!isNaN(num) && num >= 1 && num <= 5 && Number.isInteger(num)) {
      return {
        event: { type: 'SELECCIONAR_CAMPO', campo: String(num) },
        datosPatch: { campoEditando: String(num) },
      };
    }
  }

  // EDITANDO_VALOR: any text → VALOR_EDITADO
  if (state === ConversationState.EDITANDO_VALOR) {
    if (text.length > 0) {
      // Try to parse as number for numeric fields
      const campo = datos['campoEditando'];
      if (campo === '2' || campo === '4' || campo === '5') {
        // Numeric fields: try precioSchema first (accepts "1.500,50" format)
        const parsed = precioSchema.safeParse(text);
        if (parsed.success) {
          return {
            event: { type: 'VALOR_EDITADO', valor: parsed.data },
            datosPatch: {},
          };
        }
      }
      // Text fields (nombre, unidad) or fallback
      return {
        event: { type: 'VALOR_EDITADO', valor: text },
        datosPatch: {},
      };
    }
  }

  // YES/NO for CONFIRMACION_FINAL and ELIMINANDO_PRODUCTOS
  // Placed AFTER state-specific handlers so "1" in AGREGANDO_STOCK
  // maps to SELECCIONAR_PRODUCTO, not USUARIO_CONFIRMA.
  const siNo = opcionSiNoSchema.safeParse(lower);
  if (siNo.success) {
    return {
      event: siNo.data === 'si' ? { type: 'USUARIO_CONFIRMA' } : { type: 'USUARIO_RECHAZA' },
      datosPatch: {},
    };
  }

  return null;
}
