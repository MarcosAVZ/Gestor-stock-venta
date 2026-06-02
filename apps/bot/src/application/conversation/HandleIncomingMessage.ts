/**
 * @compras-whatsapp/bot — HandleIncomingMessage (use case).
 *
 * Orquesta el flujo de un mensaje entrante:
 *  1. Whitelist check (OWASP A01) — el primero y único que loggea
 *     "unauthorized_access" si el phone no está.
 *  2. Rate limit check (OWASP A04) — message o image según el tipo.
 *  3. Carga/upsert del Usuario y la Conversacion (fuente de verdad).
 *  4. Inactivity check (15 min default).
 *  5. Mapea el input a un ConversationEvent y llama al state machine.
 *  6. Si la transición tiene side effects (PEDIR_*, MOSTRAR_RESUMEN,
 *     GUARDAR, RESET) genera el texto voseo.
 *  7. Persiste el nuevo estado en Conversacion.
 *
 * POR QUÉ ACA Y NO EN EL DISPATCHER: el dispatcher (task 3.8) solo
 * hace format/IO. La lógica de negocio (whitelist + rate limit +
 * state machine + persistencia) vive en este use case, que es
 * testeable con mocks de los repos y del rate limiter.
 */

import { ConversationState, type Unidad } from '@compras-whatsapp/db';
import type { Logger } from 'pino';

import { logSecurityEvent } from '../../infrastructure/logging/logger.ts';
import {
  INACTIVITY_TIMEOUT_MS,
  isInactivo,
  transition,
  type ConversationEvent,
  type TransitionResult,
} from '../../interface/whatsapp/conversationStateMachine.ts';
import { UnauthorizedError, RateLimitError } from '../../domain/errors/OperationalError.ts';
import type { RateLimiter } from '../../infrastructure/messaging/rateLimiter.ts';
import type { ConversacionRepository } from '../../domain/repositories/ConversacionRepository.ts';
import type { UsuarioRepository } from '../../domain/repositories/UsuarioRepository.ts';

// ── Input ───────────────────────────────────────────────────────────

export type IncomingMessageInput =
  | { phone: string; type: 'text'; body: string }
  | { phone: string; type: 'image'; imagePath: string };

// ── Output ──────────────────────────────────────────────────────────

export interface HandleIncomingMessageOutput {
  responses: string[];
  /** Estado final de la conversación (para logging/testing). */
  newState: ConversationState;
  /** Si el state machine rechazó la transición. */
  rejected: boolean;
}

// ── Dependencias ────────────────────────────────────────────────────

export interface HandleIncomingMessageDeps {
  logger: Logger;
  rateLimiter: RateLimiter;
  conversacionRepo: ConversacionRepository;
  usuarioRepo: UsuarioRepository;
  /** Whitelist de phones permitidos (de OWNER_PHONE_NUMBERS). */
  whitelist: ReadonlySet<string>;
  /** Inactivity timeout (ms). Default 15 min. */
  inactivityTimeoutMs?: number;
  /** Reloj inyectable para tests. */
  clock?: () => number;
}

// ── Use case ────────────────────────────────────────────────────────

/**
 * Procesa un mensaje entrante y retorna las respuestas a enviar.
 * Esta función NO envía nada — solo computa. El caller (eventDispatcher)
 * se encarga de invocar `client.sendText(...)` con cada `response`.
 *
 * @throws {UnauthorizedError} si el phone no está en whitelist.
 * @throws {RateLimitError} si el rate limit fue excedido.
 * @throws {InvariantViolationError} si el state machine detecta un
 *   estado desconocido (no debería pasar en runtime).
 */
export async function handleIncomingMessage(
  input: IncomingMessageInput,
  deps: HandleIncomingMessageDeps,
): Promise<HandleIncomingMessageOutput> {
  const { logger, rateLimiter, conversacionRepo, usuarioRepo, whitelist } = deps;
  const now = (deps.clock ?? Date.now)();
  const inactivityMs = deps.inactivityTimeoutMs ?? INACTIVITY_TIMEOUT_MS;

  // ── 1. Whitelist ────────────────────────────────────────────────
  // El phone que llega puede tener o no el +. Normalizamos.
  const normalizedPhone = input.phone.startsWith('+') ? input.phone : `+${input.phone}`;

  if (!whitelist.has(normalizedPhone)) {
    logSecurityEvent(logger, 'unauthorized_access', { phone: normalizedPhone });
    throw new UnauthorizedError({ metadata: { from: normalizedPhone } });
  }

  // ── 2. Rate limit ──────────────────────────────────────────────
  if (input.type === 'image') {
    const verdict = rateLimiter.canSendImage(normalizedPhone, now);
    if (!verdict.allowed) {
      logSecurityEvent(logger, 'rate_limit_hit', {
        phone: normalizedPhone,
        type: 'image_burst',
        retryAfterSec: verdict.retryAfterSec,
      });
      throw new RateLimitError('Espera un momento antes de enviar otra imagen, por favor.', {
        retryAfterSec: verdict.retryAfterSec,
      });
    }
  } else {
    const verdict = rateLimiter.canSendMessage(normalizedPhone, now);
    if (!verdict.allowed) {
      logSecurityEvent(logger, 'rate_limit_hit', {
        phone: normalizedPhone,
        type: 'message_burst',
        retryAfterSec: verdict.retryAfterSec,
      });
      throw new RateLimitError('Esperá un instante antes de mandarme otro mensaje.', {
        retryAfterSec: verdict.retryAfterSec,
      });
    }
  }

  // ── 3. Usuario + Conversacion ──────────────────────────────────
  const usuario = await usuarioRepo.findByTelefono(normalizedPhone);
  if (usuario === null) {
    // Auto-crear el primer usuario (MVP: single-tenant, el dueño).
    await usuarioRepo.create({ telefono: normalizedPhone });
  }
  const usuarioId = usuario?.id ?? (await usuarioRepo.findByTelefono(normalizedPhone))?.id;
  if (usuarioId === undefined) {
    throw new Error('handleIncomingMessage: failed to resolve usuarioId after upsert');
  }

  let conversacion = await conversacionRepo.findByUsuarioId(usuarioId);
  if (conversacion === null) {
    conversacion = await conversacionRepo.upsert({
      usuarioId,
      estado: ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: {},
    });
  }

  // ── 4. Inactivity check ────────────────────────────────────────
  let workingState: ConversationState = conversacion.estado;
  let workingDatos: Record<string, unknown> = {
    ...(conversacion.datosTemporales as Record<string, unknown> | null ?? {}),
  };

  if (workingState !== ConversationState.ESPERANDO_IMAGEN && isInactivo(conversacion.updatedAt, now)) {
    logger.info(
      { event: 'conversation_inactivity_reset', previousState: workingState, inactivityMs },
      'conversation reset by inactivity',
    );
    workingState = ConversationState.ESPERANDO_IMAGEN;
    workingDatos = {};
  }

  // ── 5. Map input → ConversationEvent ───────────────────────────
  const event = inputToEvent(input, workingState);
  if (event === null) {
    // Comando no reconocido como evento de conversación. En PR5 el
    // command-dispatcher manejará "resumen", "stock", etc. Por ahora
    // respondemos con un mensaje genérico y dejamos el state en paz.
    return {
      responses: [
        'Por ahora solo proceso imágenes de compras. Pronto vas a tener comandos como "resumen" y "stock".',
      ],
      newState: workingState,
      rejected: false,
    };
  }

  // ── 6. State machine ───────────────────────────────────────────
  const context = buildContext(workingDatos, event);
  const result: TransitionResult = transition(workingState, event, context);

  if (!result.ok) {
    logSecurityEvent(logger, 'state_transition_invalid', {
      state: workingState,
      event: event.type,
    });
    return {
      responses: [result.mensaje],
      newState: workingState,
      rejected: true,
    };
  }

  // ── 7. Render responses desde la Accion ────────────────────────
  const responses = renderAccion(result.accion, workingDatos, input);

  // ── 8. Persistir nuevo estado si cambió ────────────────────────
  if (result.siguiente !== workingState) {
    const newDatos = applyAccionToDatos(workingDatos, result.accion, input);
    await conversacionRepo.update(usuarioId, {
      estado: result.siguiente,
      datosTemporales: newDatos,
    });
  }

  // ── 9. Record rate limit slot AFTER successful processing ──────
  if (input.type === 'image') {
    rateLimiter.recordImage(normalizedPhone, now);
  } else {
    rateLimiter.recordMessage(normalizedPhone, now);
  }

  return {
    responses,
    newState: result.siguiente,
    rejected: false,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Mapea el input del bot a un ConversationEvent. Si el input no
 * encaja en ningún evento del state machine (ej: un comando de query
 * en PR5), retorna `null` y el caller responde genérico.
 */
function inputToEvent(
  input: IncomingMessageInput,
  state: ConversationState,
): ConversationEvent | null {
  if (input.type === 'image') {
    return { type: 'IMAGEN_RECIBIDA' };
  }

  const text = input.body.trim();
  const lower = text.toLowerCase();

  // Comandos globales disponibles desde cualquier estado.
  if (lower === 'cancelar' || lower === 'cancel') return { type: 'CANCELAR' };
  if (lower === 'menu' || lower === 'menú' || lower === 'empezar') return { type: 'MENU' };

  // En ESPERANDO_IMAGEN, texto no es nada procesable por ahora
  // (los comandos de query llegan en PR5). Respondemos con null y
  // el handler manda un mensaje genérico.
  if (state === ConversationState.ESPERANDO_IMAGEN) {
    return null;
  }

  // YES/NO
  if (['si', 'sí', 's', 'yes', 'y', 'ok', 'dale'].includes(lower)) {
    return { type: 'USUARIO_CONFIRMA' };
  }
  if (['no', 'n', 'mal', 'incorrecto'].includes(lower)) {
    return { type: 'USUARIO_RECHAZA' };
  }
  if (lower === 'corregir' || lower.startsWith('cambiar ')) {
    const campo = lower.startsWith('cambiar ') ? text.slice(8) : 'general';
    return { type: 'USUARIO_CORRIGE', campo };
  }

  // NUMERIC INPUTS
  if (state === ConversationState.PREGUNTANDO_CANTIDAD) {
    const n = Number(text);
    if (Number.isFinite(n) && Number.isInteger(n)) return { type: 'CANTIDAD_RECIBIDA', valor: n };
  }
  if (state === ConversationState.PREGUNTANDO_PRECIO_VENTA) {
    const n = Number(text.replace(',', '.'));
    if (Number.isFinite(n) && n > 0) return { type: 'PRECIO_RECIBIDO', valor: n };
  }

  // UNIDAD
  if (state === ConversationState.PREGUNTANDO_UNIDAD) {
    const u = parseUnidad(lower);
    if (u !== null) return { type: 'UNIDAD_RECIBIDA', valor: u };
  }

  return null;
}

/** Mapea texto libre a enum Unidad. */
function parseUnidad(text: string): Unidad | null {
  if (['unidad', 'unidades', 'u'].includes(text)) return 'UNIDAD';
  if (['par', 'pares'].includes(text)) return 'PAR';
  if (['pack', 'packs'].includes(text)) return 'PACK';
  if (['caja', 'cajas'].includes(text)) return 'CAJA';
  if (['otro', 'otra'].includes(text)) return 'OTRO';
  return null;
}

/** Construye el contexto del state machine desde los datosTemporales. */
function buildContext(
  datos: Record<string, unknown>,
  _event: ConversationEvent,
): {
  productoDetectado?: string;
  costoLoteDetectado?: number;
  cantidadSugerida?: number;
  unidadSugerida?: Unidad;
} {
  return {
    productoDetectado: typeof datos['producto'] === 'string' ? (datos['producto'] as string) : undefined,
    costoLoteDetectado: typeof datos['costoLote'] === 'number' ? (datos['costoLote'] as number) : undefined,
    cantidadSugerida: typeof datos['cantidadSugerida'] === 'number' ? (datos['cantidadSugerida'] as number) : undefined,
    unidadSugerida: typeof datos['unidadSugerida'] === 'string' ? (datos['unidadSugerida'] as Unidad) : undefined,
  };
}

/** Genera el texto voseo de cada acción para enviar al usuario. */
function renderAccion(
  accion:
    | { tipo: 'DISPARAR_OCR' }
    | { tipo: 'PEDIR_CONFIRMACION'; producto: string; costoLote: number }
    | { tipo: 'PEDIR_CANTIDAD' }
    | { tipo: 'PEDIR_UNIDAD' }
    | { tipo: 'PEDIR_PRECIO_VENTA' }
    | { tipo: 'MOSTRAR_RESUMEN'; resumen: string }
    | { tipo: 'GUARDAR' }
    | { tipo: 'RESET'; mensaje: string },
  datos: Record<string, unknown>,
  input: IncomingMessageInput,
): string[] {
  switch (accion.tipo) {
    case 'DISPARAR_OCR':
      // El OCR es asíncrono (PR4). Por ahora mandamos un ack.
      return ['Procesando la imagen, dame un toque...'];
    case 'PEDIR_CONFIRMACION':
      return [
        `Detecté: ${accion.producto}, costo lote $${accion.costoLote}. ¿Es correcto? (sí/no/corregir)`,
      ];
    case 'PEDIR_CANTIDAD':
      return ['¿Cuántas unidades compraste?'];
    case 'PEDIR_UNIDAD':
      return ['¿En qué unidad? (unidad/par/pack/caja/otro)'];
    case 'PEDIR_PRECIO_VENTA': {
      // Si tenemos cantidad + unidad (de learning o ingreso previo),
      // las mencionamos en el prompt.
      const cant = datos['cantidadIngresada'] ?? datos['cantidadSugerida'];
      const unid = datos['unidadIngresada'] ?? datos['unidadSugerida'];
      if (cant !== undefined && unid !== undefined) {
        return [`OK, ${cant} ${String(unid).toLowerCase()}. ¿A cuánto vendés cada una?`];
      }
      return ['¿A cuánto vendés cada una?'];
    }
    case 'MOSTRAR_RESUMEN': {
      const producto = String(datos['producto'] ?? '?');
      const cant = datos['cantidadIngresada'] ?? datos['cantidadSugerida'];
      const unid = datos['unidadIngresada'] ?? datos['unidadSugerida'];
      const costoU = datos['costoUnitario'] ?? 0;
      const precioVenta = datos['precioVenta'] ?? 0;
      const gananciaU = Number(precioVenta) - Number(costoU);
      return [
        `Resumen: ${cant} ${String(unid).toLowerCase()} de ${producto}, ` +
          `costo $${Number(costoU).toFixed(2)} c/u, vendés a $${Number(precioVenta).toFixed(2)}, ` +
          `ganancia $${gananciaU.toFixed(2)} c/u. ¿Guardo? (sí/no)`,
      ];
    }
    case 'GUARDAR': {
      if (input.type === 'image') {
        return ['¡Listo, guardé la compra! Mandame la próxima cuando quieras.'];
      }
      return ['¡Listo, guardé la compra!'];
    }
    case 'RESET':
      return [accion.mensaje];
  }
}

/** Aplica el side effect de la acción a los datosTemporales. */
function applyAccionToDatos(
  datos: Record<string, unknown>,
  accion:
    | { tipo: 'DISPARAR_OCR' }
    | { tipo: 'PEDIR_CONFIRMACION'; producto: string; costoLote: number }
    | { tipo: 'PEDIR_CANTIDAD' }
    | { tipo: 'PEDIR_UNIDAD' }
    | { tipo: 'PEDIR_PRECIO_VENTA' }
    | { tipo: 'MOSTRAR_RESUMEN'; resumen: string }
    | { tipo: 'GUARDAR' }
    | { tipo: 'RESET'; mensaje: string },
  _input: IncomingMessageInput,
): Record<string, unknown> {
  // Por ahora la mayoria de las acciones no mutan datos. Los precios
  // y cantidades se persisten en PRECIO_RECIBIDO y CANTIDAD_RECIBIDA
  // (manejados por el caller via datosTemporales). El state machine
  // puro no sabe de input values; el orquestador los inyecta ANTES
  // de llamar transition(). Ver PR5 task 5.4 para el detail.
  switch (accion.tipo) {
    case 'RESET':
      return {};
    case 'DISPARAR_OCR':
      return { ...datos, awaitingOCR: true };
    case 'PEDIR_CONFIRMACION':
      return { ...datos, producto: accion.producto, costoLote: accion.costoLote };
    case 'MOSTRAR_RESUMEN':
      return datos; // el precioVenta se setea en PRECIO_RECIBIDO (caller)
    default:
      return datos;
  }
}
