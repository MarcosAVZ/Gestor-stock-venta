/**
 * @compras-whatsapp/bot — WhatsApp event dispatcher.
 *
 * POR QUÉ EXISTE: la lib `whatsapp-web.js` emite eventos crudos
 * (`message`, `qr`, `ready`, etc.) sobre el `Client`. El dominio de
 * la app NO quiere acoplarse a esos eventos: el adapter ya los
 * normaliza a `IncomingMessage` y los entrega al `onIncomingMessage`
 * handler (ver WhatsAppClient.ts). Este módulo conecta ese handler
 * al caso de uso `HandleIncomingMessage`.
 *
 * RESPONSABILIDADES:
 *   1. Recibir `IncomingMessage` del adapter.
 *   2. Mapear a `IncomingMessageInput` (text only).
 *   3. Llamar a `HandleIncomingMessage` con el input normalizado.
 *   4. Enviar las respuestas de vuelta al chat (text por cada string).
 *   5. Logging estructurado de todo el ciclo (A09 security events).
 *
 * NO HACE:
 *   - Validación de whitelist (eso es responsabilidad del use case).
 *   - Rate limiting (lo hace el use case).
 *   - Persistencia de Conversacion (lo hace el use case).
 */

import { ConversationState } from '@compras-whatsapp/db';
import type { Logger } from 'pino';

import {
  type HandleIncomingMessageDeps,
  type HandleIncomingMessageOutput,
  handleIncomingMessage,
} from '../../application/conversation/HandleIncomingMessage.ts';
import { handleDocumentoRecibido } from '../../application/handlers/importHandlers.ts';
import type { HandlerContext } from '../../application/handlers/HandlerContext.ts';
import { logSecurityEvent } from '../../infrastructure/logging/logger.ts';
import type {
  IncomingMessage,
  IncomingMessageHandler,
  WhatsAppMessagingPort,
} from '../../infrastructure/messaging/WhatsAppClient.ts';

// ── Tipos públicos ─────────────────────────────────────────────────

export interface EventDispatcherDeps extends HandleIncomingMessageDeps {
  port: WhatsAppMessagingPort;
}

export type Dispatcher = (msg: IncomingMessage) => Promise<void>;

/** Lo que retorna `buildEventDispatcher`. */
export interface EventDispatcherHandle {
  /** Función a pasar al `port.onIncomingMessage`. */
  handle: IncomingMessageHandler;
  /** Resuelve a la cantidad de mensajes procesados (testing/metrics). */
  processed: () => number;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Convierte `5491112345678@c.us` (formato WAWebJS) a `5491112345678`
 * (solo dígitos). Ya hecho en el adapter; este helper es un safety net
 * para tests donde se construye un IncomingMessage a mano.
 */
export function extractPhone(from: string): string {
  const at = from.indexOf('@');
  return at >= 0 ? from.slice(0, at) : from;
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Construye el handler que se conecta al `port.onIncomingMessage`.
 *
 * El handler:
 *   1. Mapea `IncomingMessage` → `IncomingMessageInput` (text only).
 *   2. Llama `handleIncomingMessage` con try/catch — NUNCA propaga
 *      excepciones hacia el adapter (eso crashearía el EventEmitter).
 *   3. Envía las respuestas al chat via `port.sendText`.
 */
export function buildEventDispatcher(deps: EventDispatcherDeps): EventDispatcherHandle {
  const { port, ...useCaseDeps } = deps;
  const logger = useCaseDeps.logger;
  let processedCount = 0;

  const handle: IncomingMessageHandler = async (msg) => {
    processedCount += 1;

    const phone = extractPhone(msg.from);
    const chatId = msg.from;

    logger.debug(
      { msgId: msg.id, type: msg.type, hasMedia: msg.hasMedia, phone },
      'dispatcher: incoming message',
    );

    // ── Document handling (import flow) ────────────────────────────
    if (msg.type === 'document' && msg.hasMedia) {
      await handleDocumentMessage(phone, chatId, msg, port, useCaseDeps, logger);
      return;
    }

    // ── Text (or image without dedicated handler) ──────────────────
    const input = { phone, type: 'text' as const, body: msg.body ?? '' };

    // Call use case with defensive try/catch
    let output: HandleIncomingMessageOutput;
    try {
      output = await handleIncomingMessage(input, useCaseDeps);
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          phone,
        },
        'dispatcher: use case threw unexpected error',
      );
      await safeSendText(
        port,
        chatId,
        'Tuve un error procesando tu mensaje. Probá de nuevo en un ratito.',
      );
      return;
    }

    // Send responses to chat (best-effort, one by one)
    for (const response of output.responses) {
      const sent = await safeSendText(port, chatId, response);
      if (!sent) break;
    }

    logger.debug(
      { phone, newState: output.newState, rejected: output.rejected, count: output.responses.length },
      'dispatcher: handled',
    );
  };

  return {
    handle,
    processed: () => processedCount,
  };
}

/**
 * Envía texto best-effort. Si falla (red caída, sesión cerrada),
 * loggea y devuelve `false` para que el caller decida si continuar.
 */
async function safeSendText(
  port: WhatsAppMessagingPort,
  to: string,
  text: string,
): Promise<boolean> {
  try {
    await port.sendText(to, text);
    return true;
  } catch (err) {
    logSecurityEvent((port as unknown as { logger?: Logger }).logger ?? safeLogger(), 'send_failed', {
      to,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Maneja un mensaje de tipo document (posible Excel para importar).
 * Descarga el buffer, verifica MIME, y si es Excel válido delega a
 * handleDocumentoRecibido. Si es otro tipo de archivo, informa error.
 */
async function handleDocumentMessage(
  phone: string,
  chatId: string,
  msg: IncomingMessage,
  port: WhatsAppMessagingPort,
  deps: HandleIncomingMessageDeps,
  logger: Logger,
): Promise<void> {
  // 1. Load conversation to check current state
  const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;
  let usuarioId: string;
  try {
    const usuario = await deps.usuarioRepo.findByTelefono(normalizedPhone);
    if (!usuario) {
      await safeSendText(port, chatId, 'Primero enviá un mensaje de texto para registrarte.');
      return;
    }
    usuarioId = usuario.id;
  } catch (err) {
    logger.error({ err: (err as Error).message, phone }, 'dispatcher: failed to load user for document');
    await safeSendText(port, chatId, 'Tuve un error procesando tu archivo. Probá de nuevo.');
    return;
  }

  // 2. Load conversation state
  let conversation: { estado: string; datosTemporales: Record<string, unknown> } | null = null;
  try {
    conversation = await deps.conversacionRepo.findByUsuarioId(usuarioId) as any;
  } catch {
    // No conversation yet — treat as not in import state
  }

  const currentState = conversation?.estado ?? '';
  const isImportState = currentState === ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO;

  // 3. Check MIME type (only Excel files are handled)
  const isExcel = msg.mimetype?.includes('spreadsheetml') ||
    msg.mimetype?.includes('excel') ||
    msg.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  if (!isExcel) {
    const response = isImportState
      ? 'Necesito un archivo Excel (.xlsx) para importar.'
      : 'No puedo procesar ese tipo de archivo. Enviá solo texto o Excel.';
    await safeSendText(port, chatId, response);
    return;
  }

  // 4. Download buffer
  let buffer: Buffer;
  try {
    buffer = await port.downloadMedia(msg.raw);
  } catch (err) {
    logger.error({ err: (err as Error).message, phone }, 'dispatcher: failed to download media');
    await safeSendText(port, chatId, 'No pude descargar el archivo. Intentá de nuevo.');
    return;
  }

  // 5. If not in import state, forward body as text and ignore the Excel content
  if (!isImportState) {
    // Treat as text message with body (caption)
    const input = { phone, type: 'text' as const, body: msg.body ?? '' };
    try {
      const output = await handleIncomingMessage(input, deps);
      for (const response of output.responses) {
        const sent = await safeSendText(port, chatId, response);
        if (!sent) break;
      }
    } catch {
      await safeSendText(port, chatId, 'Tuve un error procesando tu mensaje.');
    }
    return;
  }

  // 6. Handle Excel document in IMPORTANDO_ESPERANDO_ARCHIVO
  const ctx: HandlerContext = {
    usuarioId,
    workingState: ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO,
    workingDatos: (conversation?.datosTemporales as Record<string, unknown>) ?? {},
    conversacionRepo: deps.conversacionRepo,
    compraRepo: deps.compraRepo,
    itemCompraRepo: deps.itemCompraRepo,
    ventaRepo: deps.ventaRepo,
    prisma: deps.queryDeps.prisma,
    logger,
    exportService: deps.exportService,
    importService: deps.importService,
    chatId,
  };

  try {
    const output = await handleDocumentoRecibido(ctx, buffer);
    for (const response of output.responses) {
      const sent = await safeSendText(port, chatId, response);
      if (!sent) break;
    }
  } catch (err) {
    logger.error({ err: (err as Error).message, phone }, 'dispatcher: import document handler failed');
    await safeSendText(port, chatId, 'Tuve un error procesando el archivo Excel. Asegurate de que sea un .xlsx válido.');
  }
}

/** Logger dummy cuando el port no expone uno. */
function safeLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: () => safeLogger(),
    level: 'info',
  } as unknown as Logger;
}
