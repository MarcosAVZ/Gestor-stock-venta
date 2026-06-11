/**
 * @compras-whatsapp/bot — Conversation State Machine (función pura).
 *
 * Fuente de verdad: `Conversacion.estado` en DB.
 * Esta función NO toca DB ni WhatsApp: recibe (current, event, ctx) y
 * retorna la transición. El caller (HandleIncomingMessage) persiste.
 *
 * Por qué función pura:
 * - Testeable sin Prisma ni Chromium (ver tests/unit).
 * - Trazabilidad: dado (estado, evento) → output determinístico.
 * - Migrar a Baileys u otro adapter no toca la lógica.
 *
 * Tabla de transiciones:
 *
 * | Estado actual              | Evento                | Siguiente               | Acción
 * |----------------------------|-----------------------|-------------------------|-------
 * | PREGUNTANDO_PRODUCTO       | PRODUCTO_RECIBIDO     | PREGUNTANDO_CANTIDAD    | PEDIR_CANTIDAD
 * | PREGUNTANDO_CANTIDAD       | CANTIDAD_RECIBIDA     | PREGUNTANDO_UNIDAD      | PEDIR_UNIDAD
 * | PREGUNTANDO_UNIDAD         | UNIDAD_RECIBIDA       | PREGUNTANDO_COSTO_LOTE  | PEDIR_COSTO_LOTE
 * | PREGUNTANDO_COSTO_LOTE     | COSTO_LOTE_RECIBIDO   | PREGUNTANDO_PRECIO_VENTA| PEDIR_PRECIO_VENTA
 * | PREGUNTANDO_PRECIO_VENTA   | PRECIO_RECIBIDO       | CONFIRMACION_FINAL      | MOSTRAR_RESUMEN
 * | CONFIRMACION_FINAL         | USUARIO_CONFIRMA      | GUARDADO                | GUARDAR
 * | CONFIRMACION_FINAL         | USUARIO_RECHAZA       | PREGUNTANDO_CANTIDAD    | PEDIR_CANTIDAD
 * | GUARDADO                   | (any)                 | PREGUNTANDO_PRODUCTO    | RESET
 * | AGREGANDO_STOCK            | SELECCIONAR_PRODUCTO  | PREGUNTANDO_CANTIDAD    | PEDIR_CANTIDAD
 * | ANY                        | CANCELAR              | PREGUNTANDO_PRODUCTO    | RESET_CANCELAR
 * | ANY                        | MENU                  | PREGUNTANDO_PRODUCTO    | RESET_MENU
 * | ANY                        | TIMEOUT               | PREGUNTANDO_PRODUCTO    | RESET_TIMEOUT
 *
 * Cualquier otro (estado, evento) → `ok: false` con mensaje contextual
 * en voseo es-AR.
 */

import { ConversationState, type Unidad } from '@compras-whatsapp/db';
import { InvariantViolationError } from '../../domain/errors/ProgrammerError.ts';

// ── Events ──────────────────────────────────────────────────────────

export type ConversationEvent =
  | { type: 'PRODUCTO_RECIBIDO'; valor: string }
  | { type: 'CANTIDAD_RECIBIDA'; valor: number }
  | { type: 'UNIDAD_RECIBIDA'; valor: Unidad }
  | { type: 'COSTO_LOTE_RECIBIDO'; valor: number }
  | { type: 'PRECIO_RECIBIDO'; valor: number }
  | { type: 'USUARIO_CONFIRMA' }
  | { type: 'USUARIO_RECHAZA' }
  | { type: 'SELECCIONAR_PRODUCTO'; indice: number }
  | { type: 'CANCELAR' }
  | { type: 'MENU' }
  | { type: 'TIMEOUT' };

// ── Acciones ────────────────────────────────────────────────────────

export type Accion =
  | { tipo: 'PEDIR_PRODUCTO' }
  | { tipo: 'PEDIR_CANTIDAD' }
  | { tipo: 'PEDIR_UNIDAD' }
  | { tipo: 'PEDIR_COSTO_LOTE' }
  | { tipo: 'PEDIR_PRECIO_VENTA' }
  | { tipo: 'MOSTRAR_RESUMEN'; resumen: string }
  | { tipo: 'GUARDAR' }
  | { tipo: 'RESET'; mensaje: string }
  | { tipo: 'LISTAR_PRODUCTOS'; productos: Array<{ indice: number; nombre: string }> };

// ── Result ──────────────────────────────────────────────────────────

export type TransitionResult =
  | {
      ok: true;
      siguiente: ConversationState;
      accion: Accion;
    }
  | {
      ok: false;
      mensaje: string;
    };

// ── Context ─────────────────────────────────────────────────────────

/**
 * Contexto que el caller pasa a `transition()`. El state machine es
 * puro: el contexto es read-only.
 */
export interface TransitionContext {
  productosDisponibles?: Array<{
    indice: number;
    nombre: string;
    costoLote: number;
    precioVenta: number;
  }>;
}

// ── Constants ───────────────────────────────────────────────────────

/** Inactivity reset threshold (ms). El caller compara updatedAt + this. */
export const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min (test-friendly; prod = 15min via env)

// ── Public API ──────────────────────────────────────────────────────

/**
 * Pure function: dado (current, event, context) retorna el resultado
 * de la transición. NO muta, NO consulta DB, NO loggea.
 *
 * @throws {InvariantViolationError} SOLO si se llama con un estado
 *   desconocido (no del enum). Las transiciones inválidas retornan
 *   `{ ok: false, mensaje }` con texto amigable para responder al user.
 */
export function transition(
  current: ConversationState,
  event: ConversationEvent,
  _context: TransitionContext = {},
): TransitionResult {
  // CANCELAR / MENU / TIMEOUT aplican desde cualquier estado.
  if (event.type === 'CANCELAR') {
    return ok(ConversationState.PREGUNTANDO_PRODUCTO, {
      tipo: 'RESET',
      mensaje: 'Listo, cancelé. Empecemos de nuevo.',
    });
  }
  if (event.type === 'MENU') {
    return ok(ConversationState.PREGUNTANDO_PRODUCTO, {
      tipo: 'RESET',
      mensaje: 'Empecemos de nuevo. Decime: nueva, agregar, ayuda, etc.',
    });
  }
  if (event.type === 'TIMEOUT') {
    return ok(ConversationState.PREGUNTANDO_PRODUCTO, {
      tipo: 'RESET',
      mensaje: 'Tu sesión se cerró por inactividad. Mandame un mensaje nuevo.',
    });
  }

  switch (current) {
    case ConversationState.PREGUNTANDO_PRODUCTO:
      if (event.type === 'PRODUCTO_RECIBIDO') {
        return ok(ConversationState.PREGUNTANDO_CANTIDAD, { tipo: 'PEDIR_CANTIDAD' });
      }
      return invalid(current, event);

    case ConversationState.PREGUNTANDO_CANTIDAD:
      if (event.type === 'CANTIDAD_RECIBIDA') {
        if (event.valor <= 0) {
          return {
            ok: false,
            mensaje: 'La cantidad tiene que ser mayor a cero, ¿cuántas unidades compraste?',
          };
        }
        return ok(ConversationState.PREGUNTANDO_UNIDAD, { tipo: 'PEDIR_UNIDAD' });
      }
      return invalid(current, event, 'esperaba un número');

    case ConversationState.PREGUNTANDO_UNIDAD:
      if (event.type === 'UNIDAD_RECIBIDA') {
        return ok(ConversationState.PREGUNTANDO_COSTO_LOTE, {
          tipo: 'PEDIR_COSTO_LOTE',
        });
      }
      return invalid(current, event, 'esperaba una unidad (unidad/par/pack/caja/otro)');

    case ConversationState.PREGUNTANDO_COSTO_LOTE:
      if (event.type === 'COSTO_LOTE_RECIBIDO') {
        return ok(ConversationState.PREGUNTANDO_PRECIO_VENTA, {
          tipo: 'PEDIR_PRECIO_VENTA',
        });
      }
      return invalid(current, event, 'esperaba un número');

    case ConversationState.PREGUNTANDO_PRECIO_VENTA:
      if (event.type === 'PRECIO_RECIBIDO') {
        if (event.valor <= 0) {
          return {
            ok: false,
            mensaje: 'El precio tiene que ser mayor a cero, ¿a cuánto vendés cada una?',
          };
        }
        return ok(ConversationState.CONFIRMACION_FINAL, {
          tipo: 'MOSTRAR_RESUMEN',
          resumen: 'ok', // el caller arma el resumen real con los datos
        });
      }
      return invalid(current, event, 'esperaba un número');

    case ConversationState.CONFIRMACION_FINAL:
      if (event.type === 'USUARIO_CONFIRMA') {
        return ok(ConversationState.GUARDADO, { tipo: 'GUARDAR' });
      }
      if (event.type === 'USUARIO_RECHAZA') {
        return ok(ConversationState.PREGUNTANDO_CANTIDAD, { tipo: 'PEDIR_CANTIDAD' });
      }
      return invalid(current, event);

    case ConversationState.GUARDADO:
      // GUARDADO es un estado transitorio. Cualquier evento vuelve
      // a PREGUNTANDO_PRODUCTO.
      return ok(ConversationState.PREGUNTANDO_PRODUCTO, {
        tipo: 'RESET',
        mensaje: 'Guardado. ¿Querés cargar otro producto?',
      });

    case ConversationState.AGREGANDO_STOCK:
      if (event.type === 'SELECCIONAR_PRODUCTO') {
        return ok(ConversationState.PREGUNTANDO_CANTIDAD, { tipo: 'PEDIR_CANTIDAD' });
      }
      return invalid(current, event);

    default: {
      // Exhaustiveness check: si Prisma agrega un estado nuevo al enum
      // y olvidamos actualizar este switch, esto lo cacha.
      const _exhaustive: never = current;
      throw new InvariantViolationError(
        `Unknown ConversationState: ${String(_exhaustive)}`,
        { metadata: { state: String(_exhaustive) } },
      );
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function ok(siguiente: ConversationState, accion: Accion): TransitionResult {
  return { ok: true, siguiente, accion };
}

function invalid(
  current: ConversationState,
  _event: ConversationEvent,
  expectedHint?: string,
): TransitionResult {
  const base = expectedHint
    ? `Esperaba ${expectedHint}, no otro tipo de respuesta.`
    : `No entendí. En el estado ${current} no esperaba este mensaje.`;
  return {
    ok: false,
    mensaje: `${base} Si querés empezar de nuevo, mandá "cancelar".`,
  };
}

/**
 * Helper para chequear inactividad: el caller compara
 * `Date.now() - conversacion.updatedAt > INACTIVITY_TIMEOUT_MS` y
 * si es true, llama a `transition(current, { type: 'TIMEOUT' })`.
 *
 * Exportado para que el dispatcher no duplique la constante.
 */
export function isInactivo(updatedAt: Date, now: number = Date.now()): boolean {
  return now - updatedAt.getTime() > INACTIVITY_TIMEOUT_MS;
}
