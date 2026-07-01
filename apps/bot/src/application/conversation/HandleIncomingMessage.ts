/**
 * @compras-whatsapp/bot — HandleIncomingMessage (use case).
 *
 * Orquesta el flujo de un mensaje entrante:
 *  1. Whitelist check (OWASP A01)
 *  2. Rate limit check (OWASP A04)
 *  3. Carga/upsert del Usuario y la Conversacion
 *  4. Inactivity check (15 min default)
 *  5. Command dispatch: slash → query → state machine
 *  6. Persist new state
 *
 * Handler logic is extracted to:
 * - handlers/slashHandlers.ts — /nueva, /agregar, /editar, /eliminar, /ayuda
 * - handlers/inputMapper.ts — input → event mapping
 * - handlers/actionRenderer.ts — action → text rendering
 * - handlers/stateHandlers.ts — special-case state transitions
 */

import { ConversationState } from '@compras-whatsapp/db';
import type { Logger } from 'pino';

import { logSecurityEvent } from '../../infrastructure/logging/logger.ts';
import {
  INACTIVITY_TIMEOUT_MS,
  isInactivo,
  transition,
} from '../../interface/whatsapp/conversationStateMachine.ts';
import { UnauthorizedError, RateLimitError } from '../../domain/errors/OperationalError.ts';
import type { RateLimiter } from '../../infrastructure/messaging/rateLimiter.ts';
import type { ConversacionRepository } from '../../domain/repositories/ConversacionRepository.ts';
import type { CompraRepository } from '../../domain/repositories/CompraRepository.ts';
import type { ItemCompraRepository } from '../../domain/repositories/ItemCompraRepository.ts';
import type { VentaRepository } from '../../domain/repositories/VentaRepository.ts';
import type { UsuarioRepository } from '../../domain/repositories/UsuarioRepository.ts';
import { parseCommand } from '../commands/parseCommand.ts';
import { saveCompra, type DatosParaGuardar } from './SaveCompra.ts';
import {
  executeQuery,
  parseQueryCommand,
  logUnknownCommand,
  UNKNOWN_COMMAND_MESSAGE,
  type QueryDeps,
} from '../queries/index.ts';

// ── Handler imports ──────────────────────────────────────────────────
import { handleSlashCommand } from '../handlers/slashHandlers.ts';
import { inputToEvent } from '../handlers/inputMapper.ts';
import { renderAccion, applyAccionToDatos } from '../handlers/actionRenderer.ts';
import { handleSpecialCase } from '../handlers/stateHandlers.ts';
import type { ExportService } from '../excel/ExportService.ts';
import type { ImportService } from '../excel/ImportService.ts';
import type { HandlerContext } from '../handlers/HandlerContext.ts';

// ── Input/Output ────────────────────────────────────────────────────

export type IncomingMessageInput =
  | { phone: string; type: 'text'; body: string };

export interface HandleIncomingMessageOutput {
  responses: string[];
  newState: ConversationState;
  rejected: boolean;
}

// ── Dependencias ────────────────────────────────────────────────────

export interface HandleIncomingMessageDeps {
  logger: Logger;
  rateLimiter: RateLimiter;
  conversacionRepo: ConversacionRepository;
  usuarioRepo: UsuarioRepository;
  compraRepo: CompraRepository;
  itemCompraRepo: ItemCompraRepository;
  ventaRepo: VentaRepository;
  queryDeps: QueryDeps;
  whitelist: ReadonlySet<string>;
  inactivityTimeoutMs?: number;
  clock?: () => number;
  exportService: ExportService;
  importService: ImportService;
}

// ── Helpers ─────────────────────────────────────────────────────────

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

// ── Use case ────────────────────────────────────────────────────────

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

  // ── 2. Rate limit ──────────────────────────────────────────────
  const verdict = rateLimiter.canSendMessage(normalizedPhone, now);
  if (!verdict.allowed) {
    logSecurityEvent(logger, 'rate_limit_hit', {
      phone: normalizedPhone, type: 'message_burst', retryAfterSec: verdict.retryAfterSec,
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

  // ── 5. Command dispatch ───────────────────────────────────────
  // 5a. Slash commands (highest priority)
  const slashCmd = parseCommand(input.body);
  if (slashCmd !== null) {
    const ctx: HandlerContext = {
      usuarioId, workingState, workingDatos,
      conversacionRepo, compraRepo: deps.compraRepo,
      itemCompraRepo: deps.itemCompraRepo,
      ventaRepo: deps.ventaRepo,
      prisma: queryDeps.prisma, logger,
      exportService: deps.exportService,
      chatId: `${input.phone}@c.us`,
    };
    const slashResult = await handleSlashCommand(slashCmd, ctx);
    rateLimiter.recordMessage(normalizedPhone, now);
    return slashResult;
  }

  // 5b. Query commands (second priority)
  const queryCmd = parseQueryCommand(input.body);
  if (queryCmd !== null) {
    logger.info({ event: 'query_executed', cmd: queryCmd.type, phone: normalizedPhone }, 'query dispatched');
    const response = await executeQuery(queryCmd, usuarioId, queryDeps);
    rateLimiter.recordMessage(normalizedPhone, now);
    return { responses: [response], newState: workingState, rejected: false };
  }

  // 5c. Free text → state machine
  const mapping = inputToEvent(input, workingState, workingDatos);
  if (mapping === null) {
    logUnknownCommand(logger, input.body);
    rateLimiter.recordMessage(normalizedPhone, now);
    return { responses: [UNKNOWN_COMMAND_MESSAGE], newState: workingState, rejected: false };
  }

  const { event, datosPatch } = mapping;
  workingDatos = { ...workingDatos, ...datosPatch };

  // ── 5c-i. Special-case handlers ──────────────────────────────
  const ctx: HandlerContext = {
    usuarioId, workingState, workingDatos,
    conversacionRepo, compraRepo: deps.compraRepo,
    itemCompraRepo: deps.itemCompraRepo,
    ventaRepo: deps.ventaRepo,
    prisma: queryDeps.prisma, logger,
    exportService: deps.exportService,
    chatId: `${input.phone}@c.us`,
  };
  const specialResult = await handleSpecialCase({ workingState, event, workingDatos, ctx });
  if (specialResult !== null) {
    rateLimiter.recordMessage(normalizedPhone, now);
    return specialResult;
  }

  // ── 5c-ii. Pure state machine ────────────────────────────────
  const smContext = buildContext(workingDatos);
  const result = transition(workingState, event, smContext);

  if (!result.ok) {
    logSecurityEvent(logger, 'state_transition_invalid', { state: workingState, event: event.type });
    rateLimiter.recordMessage(normalizedPhone, now);
    return { responses: [result.mensaje], newState: workingState, rejected: true };
  }

  // ── Persist GUARDAR action ───────────────────────────────────
  if (result.accion.tipo === 'GUARDAR') {
    const datosParaGuardar: DatosParaGuardar = workingDatos as unknown as DatosParaGuardar;
    try {
      const guardado = await saveCompra(
        { usuarioId, datos: datosParaGuardar },
        { compraRepo: deps.compraRepo, itemCompraRepo: deps.itemCompraRepo },
      );
      logger.info({
        event: 'compra_guardada', compraId: guardado.compraId,
        costoUnitario: guardado.metricas.costoUnitario,
        gananciaUnitaria: guardado.metricas.gananciaUnitaria,
      }, 'compra persistida por state machine');
    } catch (err) {
      logger.error({
        event: 'compra_save_failed',
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }, 'fallo al guardar la compra');
      rateLimiter.recordMessage(normalizedPhone, now);
      return {
        responses: ['Ufa, no pude guardar la compra. ¿Probamos de nuevo? Decí "sí" o "cancelar".'],
        newState: workingState, rejected: true,
      };
    }
  }

  // ── Render + persist ─────────────────────────────────────────
  const responses = renderAccion(result.accion, workingDatos);
  if (result.siguiente !== workingState) {
    const newDatos = applyAccionToDatos(workingDatos, result.accion);
    await conversacionRepo.update(usuarioId, { estado: result.siguiente, datosTemporales: newDatos });
  }

  rateLimiter.recordMessage(normalizedPhone, now);
  return { responses, newState: result.siguiente, rejected: false };
}
