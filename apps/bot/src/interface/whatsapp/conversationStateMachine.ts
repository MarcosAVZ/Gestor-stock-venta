/**
 * @compras-whatsapp/bot — Conversation State Machine (función pura).
 *
 * Fuente de verdad: `Conversacion.estado` en DB (PR2).
 * Esta función NO toca DB ni WhatsApp: recibe (current, event, ctx) y
 * retorna la transición. El caller (HandleIncomingMessage) persiste.
 *
 * Por qué función pura:
 * - Testeable sin Prisma ni Chromium (ver tests/unit).
 * - Trazabilidad: dado (estado, evento) → output determinístico.
 * - Migrar a Baileys u otro adapter no toca la lógica.
 *
 * Tabla de transiciones (sdd-design obs#28 sección 4.2 + spec
 * req-conversation-state-machine):
 *
 * | Estado actual              | Evento                | Siguiente               | Acción
 * |----------------------------|-----------------------|-------------------------|-------
 * | ESPERANDO_IMAGEN           | IMAGEN_RECIBIDA       | VALIDANDO_DATOS         | DISPARAR_OCR
 * | VALIDANDO_DATOS            | USUARIO_CONFIRMA      | PREGUNTANDO_CANTIDAD    | PEDIR_CANTIDAD
 * | VALIDANDO_DATOS            | USUARIO_RECHAZA       | VALIDANDO_DATOS         | PEDIR_CONFIRMACION
 * | VALIDANDO_DATOS            | USUARIO_CORRIGE       | VALIDANDO_DATOS         | PEDIR_CONFIRMACION
 * | PREGUNTANDO_CANTIDAD       | CANTIDAD_RECIBIDA     | PREGUNTANDO_UNIDAD      | PEDIR_UNIDAD
 * | PREGUNTANDO_UNIDAD         | UNIDAD_RECIBIDA       | PREGUNTANDO_PRECIO_VENTA| PEDIR_PRECIO_VENTA
 * | PREGUNTANDO_PRECIO_VENTA   | PRECIO_RECIBIDO       | CONFIRMACION_FINAL      | MOSTRAR_RESUMEN
 * | CONFIRMACION_FINAL         | USUARIO_CONFIRMA      | GUARDADO                | GUARDAR
 * | CONFIRMACION_FINAL         | USUARIO_RECHAZA       | PREGUNTANDO_CANTIDAD    | PEDIR_CANTIDAD
 * | ANY                        | CANCELAR              | ESPERANDO_IMAGEN        | RESET_CANCELAR
 * | ANY                        | MENU                  | ESPERANDO_IMAGEN        | RESET_MENU
 * | ANY                        | TIMEOUT               | ESPERANDO_IMAGEN        | RESET_TIMEOUT
 *
 * Excepción — learning (PR5 task 5.4): si la SuggestSimilarProduct
 * encuentra un match con `similarity >= 0.4`, `USUARIO_CONFIRMA` salta
 * `PREGUNTANDO_CANTIDAD` y `PREGUNTANDO_UNIDAD`, va directo a
 * `PREGUNTANDO_PRECIO_VENTA` con los datos prellenados.
 *
 * Cualquier otro (estado, evento) → `ok: false` con mensaje contextual
 * en voseo es-AR.
 */

import { ConversationState, type Unidad } from '@compras-whatsapp/db';
import { InvariantViolationError } from '../../domain/errors/ProgrammerError.ts';

// ── Events ──────────────────────────────────────────────────────────

export type ConversationEvent =
  | { type: 'IMAGEN_RECIBIDA' }
  | { type: 'USUARIO_CONFIRMA' }
  | { type: 'USUARIO_RECHAZA' }
  | { type: 'USUARIO_CORRIGE'; campo: string }
  | { type: 'CANTIDAD_RECIBIDA'; valor: number }
  | { type: 'UNIDAD_RECIBIDA'; valor: Unidad }
  | { type: 'PRECIO_RECIBIDO'; valor: number }
  | { type: 'CANCELAR' }
  | { type: 'MENU' }
  | { type: 'TIMEOUT' };

// ── Acciones ────────────────────────────────────────────────────────

export type Accion =
  | { tipo: 'DISPARAR_OCR' }
  | { tipo: 'PEDIR_CONFIRMACION'; producto: string; costoLote: number }
  | { tipo: 'PEDIR_CANTIDAD' }
  | { tipo: 'PEDIR_UNIDAD' }
  | { tipo: 'PEDIR_PRECIO_VENTA' }
  | { tipo: 'MOSTRAR_RESUMEN'; resumen: string }
  | { tipo: 'GUARDAR' }
  | { tipo: 'RESET'; mensaje: string };

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
 * puro: el contexto es read-only. Datos de la conversación actual
 * (producto detectado, costoLote, sugerencia de learning, etc.) +
 * flags de control.
 */
export interface TransitionContext {
  /** Producto detectado por OCR (presente en VALIDANDO_DATOS). */
  productoDetectado?: string;
  /** Costo del lote detectado por OCR (presente en VALIDANDO_DATOS). */
  costoLoteDetectado?: number;
  /** Cantidad prellenada por learning (PR5). Si está, saltamos PREGUNTANDO_CANTIDAD. */
  cantidadSugerida?: number;
  /** Unidad prellenada por learning (PR5). Si está, saltamos PREGUNTANDO_UNIDAD. */
  unidadSugerida?: Unidad;
  /** Cantidad validada por el usuario (presente en PREGUNTANDO_PRECIO_VENTA+). */
  cantidadIngresada?: number;
  /** Unidad validada por el usuario. */
  unidadIngresada?: Unidad;
  /** Precio de venta (presente en CONFIRMACION_FINAL). */
  precioVentaIngresado?: number;
  /** Costo unitario (calculado en PREGUNTANDO_PRECIO_VENTA → CONFIRMACION_FINAL). */
  costoUnitario?: number;
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
  context: TransitionContext = {},
): TransitionResult {
  // CANCELAR / MENU / TIMEOUT aplican desde cualquier estado.
  if (event.type === 'CANCELAR') {
    return ok(ConversationState.ESPERANDO_IMAGEN, {
      tipo: 'RESET',
      mensaje: 'Listo, cancelé. Mandame la próxima imagen.',
    });
  }
  if (event.type === 'MENU') {
    return ok(ConversationState.ESPERANDO_IMAGEN, {
      tipo: 'RESET',
      mensaje: 'Empecemos de nuevo. Mandame imagen o decime: resumen, stock, etc.',
    });
  }
  if (event.type === 'TIMEOUT') {
    return ok(ConversationState.ESPERANDO_IMAGEN, {
      tipo: 'RESET',
      mensaje: 'Tu sesión se cerró por inactividad. Mandame una imagen nueva.',
    });
  }

  switch (current) {
    case ConversationState.ESPERANDO_IMAGEN:
      if (event.type === 'IMAGEN_RECIBIDA') {
        return ok(ConversationState.VALIDANDO_DATOS, { tipo: 'DISPARAR_OCR' });
      }
      return invalid(current, event);

    case ConversationState.VALIDANDO_DATOS:
      if (event.type === 'USUARIO_CONFIRMA') {
        // Learning skip (PR5): si hay sugerencia, vamos directo a PRECIO.
        if (context.cantidadSugerida !== undefined && context.unidadSugerida !== undefined) {
          return ok(ConversationState.PREGUNTANDO_PRECIO_VENTA, {
            tipo: 'PEDIR_PRECIO_VENTA',
          });
        }
        return ok(ConversationState.PREGUNTANDO_CANTIDAD, { tipo: 'PEDIR_CANTIDAD' });
      }
      if (event.type === 'USUARIO_RECHAZA' || event.type === 'USUARIO_CORRIGE') {
        const producto = context.productoDetectado ?? '';
        const costoLote = context.costoLoteDetectado ?? 0;
        if (producto === '' || costoLote === 0) {
          return invalid(current, event, 'no hay datos para re-confirmar');
        }
        return ok(ConversationState.VALIDANDO_DATOS, {
          tipo: 'PEDIR_CONFIRMACION',
          producto,
          costoLote,
        });
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
        return ok(ConversationState.PREGUNTANDO_PRECIO_VENTA, {
          tipo: 'PEDIR_PRECIO_VENTA',
        });
      }
      return invalid(current, event, 'esperaba una unidad (unidad/par/pack/caja/otro)');

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
      // a ESPERANDO_IMAGEN (o lo deja si es un evento global que
      // ya manejamos arriba).
      return ok(ConversationState.ESPERANDO_IMAGEN, {
        tipo: 'RESET',
        mensaje: 'Mandame la próxima imagen cuando quieras.',
      });

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
 * Exportado para que el dispatcher (task 3.8) no duplique la constante.
 */
export function isInactivo(updatedAt: Date, now: number = Date.now()): boolean {
  return now - updatedAt.getTime() > INACTIVITY_TIMEOUT_MS;
}
