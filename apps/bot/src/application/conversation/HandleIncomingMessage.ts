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

import { ConversationState } from '@compras-whatsapp/db';
import type { Logger } from 'pino';

import {
  cantidadSchema,
  opcionSiNoSchema,
  opcionUnidadSchema,
  precioSchema,
} from '@compras-whatsapp/shared';

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
import type { CompraRepository } from '../../domain/repositories/CompraRepository.ts';
import type { ItemCompraRepository } from '../../domain/repositories/ItemCompraRepository.ts';
import type { UsuarioRepository } from '../../domain/repositories/UsuarioRepository.ts';
import { parseCommand, type BotCommand } from '../commands/parseCommand.ts';
import { saveCompra, type DatosParaGuardar } from './SaveCompra.ts';
import {
  executeQuery,
  parseQueryCommand,
  logUnknownCommand,
  UNKNOWN_COMMAND_MESSAGE,
  HELP_TEXT,
  type QueryDeps,
} from '../queries/index.ts';

// ── Input ───────────────────────────────────────────────────────────

export type IncomingMessageInput =
  | { phone: string; type: 'text'; body: string };

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
  /** Repos para SaveCompra (PR5 task 5.5). */
  compraRepo: CompraRepository;
  itemCompraRepo: ItemCompraRepository;
  /** Deps para los 8 query use cases (PR5 task 5.6). */
  queryDeps: QueryDeps;
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
  const { logger, rateLimiter, conversacionRepo, usuarioRepo, queryDeps, whitelist } = deps;
  const now = (deps.clock ?? Date.now)();
  const inactivityMs = deps.inactivityTimeoutMs ?? INACTIVITY_TIMEOUT_MS;

  // ── 1. Whitelist ────────────────────────────────────────────────
  const normalizedPhone = input.phone.startsWith('+') ? input.phone : `+${input.phone}`;

  if (!whitelist.has(normalizedPhone)) {
    logSecurityEvent(logger, 'unauthorized_access', { phone: normalizedPhone });
    throw new UnauthorizedError({ metadata: { from: normalizedPhone } });
  }

  // ── 2. Rate limit (text only) ──────────────────────────────────
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

  // ── 3. Usuario + Conversacion ──────────────────────────────────
  const usuario = await usuarioRepo.findByTelefono(normalizedPhone);
  if (usuario === null) {
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
      estado: ConversationState.PREGUNTANDO_PRODUCTO,
      datosTemporales: {},
    });
  }

  // ── 4. Inactivity check ────────────────────────────────────────
  let workingState: ConversationState = conversacion.estado;
  let workingDatos: Record<string, unknown> = {
    ...(conversacion.datosTemporales as Record<string, unknown> | null ?? {}),
  };

  if (isInactivo(conversacion.updatedAt, now)) {
    logger.info(
      { event: 'conversation_inactivity_reset', previousState: workingState, inactivityMs },
      'conversation reset by inactivity',
    );
    workingState = ConversationState.PREGUNTANDO_PRODUCTO;
    workingDatos = {};
  }

  // ── 5. Command dispatch (priority order) ──────────────────────
  // 5a. Slash commands (/nueva, /agregar, /ayuda) — highest priority
  const slashCmd = parseCommand(input.body);
  if (slashCmd !== null) {
    const slashResult = await handleSlashCommand(slashCmd, usuarioId, workingState, deps);
    rateLimiter.recordMessage(normalizedPhone, now);
    return slashResult;
  }

  // 5b. Query commands (resumen, stock, etc.) — second priority
  const queryCmd = parseQueryCommand(input.body);
  if (queryCmd !== null) {
    logger.info(
      { event: 'query_executed', cmd: queryCmd.type, phone: normalizedPhone },
      'query dispatched',
    );
    const response = await executeQuery(queryCmd, usuarioId, queryDeps);
    rateLimiter.recordMessage(normalizedPhone, now);
    return {
      responses: [response],
      newState: workingState,
      rejected: false,
    };
  }

  // 5c. Free text → state machine
  const mapping = inputToEvent(input, workingState);
  if (mapping === null) {
    logUnknownCommand(logger, input.body);
    return {
      responses: [UNKNOWN_COMMAND_MESSAGE],
      newState: workingState,
      rejected: false,
    };
  }
  const { event, datosPatch } = mapping;
  workingDatos = { ...workingDatos, ...datosPatch };
  const result = await runStateMachine({
    input,
    workingState,
    workingDatos,
    usuarioId,
    event,
    deps,
  });
  rateLimiter.recordMessage(normalizedPhone, now);
  return result;
}

/**
 * Handles slash commands (/nueva, /agregar, /ayuda).
 * Returns the response without going through the state machine.
 */
async function handleSlashCommand(
  cmd: BotCommand,
  usuarioId: string,
  workingState: ConversationState,
  deps: HandleIncomingMessageDeps,
): Promise<HandleIncomingMessageOutput> {
  const { conversacionRepo } = deps;

  switch (cmd.type) {
    case 'nueva': {
      // Set state to PREGUNTANDO_PRODUCTO and ask for product
      await conversacionRepo.update(usuarioId, {
        estado: ConversationState.PREGUNTANDO_PRODUCTO,
        datosTemporales: {},
      });
      return {
        responses: ['¿Qué producto compraste?'],
        newState: ConversationState.PREGUNTANDO_PRODUCTO,
        rejected: false,
      };
    }
    case 'agregar': {
      // Set state to AGREGANDO_STOCK
      await conversacionRepo.update(usuarioId, {
        estado: ConversationState.AGREGANDO_STOCK,
        datosTemporales: {},
      });
      return {
        responses: ['Seleccioná un producto de la lista.'],
        newState: ConversationState.AGREGANDO_STOCK,
        rejected: false,
      };
    }
    case 'ayuda': {
      // Return help text, no state change
      return {
        responses: [HELP_TEXT],
        newState: workingState,
        rejected: false,
      };
    }
  }
}

/**
 * Executes the state machine + action dispatch (PEDIR_*, GUARDAR, etc.).
 */
async function runStateMachine(params: {
  input: IncomingMessageInput;
  workingState: ConversationState;
  workingDatos: Record<string, unknown>;
  usuarioId: string;
  event: ConversationEvent;
  deps: HandleIncomingMessageDeps;
}): Promise<HandleIncomingMessageOutput> {
  const { workingState, workingDatos, usuarioId, event, deps } = params;
  const { logger, conversacionRepo, compraRepo, itemCompraRepo } = deps;

  // ── State machine ──────────────────────────────────────────────
  const context = buildContext(workingDatos);
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

  // ── Persist if action is GUARDAR ───────────────────────────────
  if (result.accion.tipo === 'GUARDAR') {
    const datosParaGuardar: DatosParaGuardar = workingDatos as unknown as DatosParaGuardar;
    try {
      const guardado = await saveCompra(
        { usuarioId, datos: datosParaGuardar },
        { compraRepo, itemCompraRepo },
      );
      logger.info(
        {
          event: 'compra_guardada',
          compraId: guardado.compraId,
          costoUnitario: guardado.metricas.costoUnitario,
          gananciaUnitaria: guardado.metricas.gananciaUnitaria,
        },
        'compra persistida por state machine',
      );
    } catch (err) {
      logger.error(
        {
          event: 'compra_save_failed',
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        'fallo al guardar la compra',
      );
      return {
        responses: [
          'Ufa, no pude guardar la compra. ¿Probamos de nuevo? Decí "sí" o "cancelar".',
        ],
        newState: workingState,
        rejected: true,
      };
    }
  }

  // ── Render responses from Accion ───────────────────────────────
  const responses = renderAccion(result.accion, workingDatos);

  // ── Persist new state if changed ───────────────────────────────
  if (result.siguiente !== workingState) {
    const newDatos = applyAccionToDatos(workingDatos, result.accion);
    await conversacionRepo.update(usuarioId, {
      estado: result.siguiente,
      datosTemporales: newDatos,
    });
  }

  return {
    responses,
    newState: result.siguiente,
    rejected: false,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Maps input to a ConversationEvent. Returns null if input doesn't
 * match any event for the current state.
 */
function inputToEvent(
  input: IncomingMessageInput,
  state: ConversationState,
): { event: ConversationEvent; datosPatch: Record<string, unknown> } | null {
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

  // YES/NO for CONFIRMACION_FINAL
  const siNo = opcionSiNoSchema.safeParse(lower);
  if (siNo.success) {
    return {
      event: siNo.data === 'si' ? { type: 'USUARIO_CONFIRMA' } : { type: 'USUARIO_RECHAZA' },
      datosPatch: {},
    };
  }

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

  return null;
}

/** Builds the state machine context from datosTemporales. */
function buildContext(
  datos: Record<string, unknown>,
): {
  productosDisponibles?: Array<{ indice: number; nombre: string; costoLote: number; precioVenta: number }>;
} {
  return {
    productosDisponibles: Array.isArray(datos['productosDisponibles'])
      ? (datos['productosDisponibles'] as Array<{ indice: number; nombre: string; costoLote: number; precioVenta: number }>)
      : undefined,
  };
}

/** Generates voseo text for each action to send to the user. */
function renderAccion(
  accion:
    | { tipo: 'PEDIR_PRODUCTO' }
    | { tipo: 'PEDIR_CANTIDAD' }
    | { tipo: 'PEDIR_UNIDAD' }
    | { tipo: 'PEDIR_COSTO_LOTE' }
    | { tipo: 'PEDIR_PRECIO_VENTA' }
    | { tipo: 'MOSTRAR_RESUMEN'; resumen: string }
    | { tipo: 'GUARDAR' }
    | { tipo: 'RESET'; mensaje: string }
    | { tipo: 'LISTAR_PRODUCTOS'; productos: Array<{ indice: number; nombre: string }> },
  datos: Record<string, unknown>,
): string[] {
  switch (accion.tipo) {
    case 'PEDIR_PRODUCTO':
      return ['¿Qué producto compraste?'];
    case 'PEDIR_CANTIDAD':
      return ['¿Cuántas unidades compraste?'];
    case 'PEDIR_UNIDAD':
      return ['¿En qué unidad? (unidad/par/pack/caja/otro)'];
    case 'PEDIR_COSTO_LOTE':
      return ['¿Cuánto te costó el lote? (precio en pesos)'];
    case 'PEDIR_PRECIO_VENTA': {
      const cant = datos['cantidadIngresada'];
      const unid = datos['unidadIngresada'];
      if (cant !== undefined && unid !== undefined) {
        return [`OK, ${cant} ${String(unid).toLowerCase()}. ¿A cuánto vendés cada una?`];
      }
      return ['¿A cuánto vendés cada una?'];
    }
    case 'MOSTRAR_RESUMEN': {
      const producto = String(datos['producto'] ?? '?');
      const cant = datos['cantidadIngresada'];
      const unid = datos['unidadIngresada'];
      const costoU = datos['costoUnitario'] ?? 0;
      const precioVenta = datos['precioVenta'] ?? 0;
      const gananciaU = Number(precioVenta) - Number(costoU);
      return [
        `Resumen: ${cant} ${String(unid).toLowerCase()} de ${producto}, ` +
          `costo $${Number(costoU).toFixed(2)} c/u, vendés a $${Number(precioVenta).toFixed(2)}, ` +
          `ganancia $${gananciaU.toFixed(2)} c/u. ¿Guardo? (sí/no)`,
      ];
    }
    case 'GUARDAR':
      return ['¡Listo, guardé la compra!'];
    case 'RESET':
      return [accion.mensaje];
    case 'LISTAR_PRODUCTOS': {
      if (accion.productos.length === 0) {
        return ['No tenés productos cargados. Usá /nueva para empezar.'];
      }
      const lines = accion.productos.map((p) => `${p.indice}. ${p.nombre}`);
      return [`Seleccioná un producto:\n${lines.join('\n')}`];
    }
  }
}

/** Applies the action's side effect to datosTemporales. */
function applyAccionToDatos(
  datos: Record<string, unknown>,
  accion:
    | { tipo: 'PEDIR_PRODUCTO' }
    | { tipo: 'PEDIR_CANTIDAD' }
    | { tipo: 'PEDIR_UNIDAD' }
    | { tipo: 'PEDIR_COSTO_LOTE' }
    | { tipo: 'PEDIR_PRECIO_VENTA' }
    | { tipo: 'MOSTRAR_RESUMEN'; resumen: string }
    | { tipo: 'GUARDAR' }
    | { tipo: 'RESET'; mensaje: string }
    | { tipo: 'LISTAR_PRODUCTOS'; productos: Array<{ indice: number; nombre: string }> },
): Record<string, unknown> {
  switch (accion.tipo) {
    case 'RESET':
      return {};
    case 'MOSTRAR_RESUMEN':
      return datos;
    default:
      return datos;
  }
}
