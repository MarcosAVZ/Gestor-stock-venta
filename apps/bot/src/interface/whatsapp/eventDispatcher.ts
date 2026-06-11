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

import type { Logger } from 'pino';

import {
  type HandleIncomingMessageDeps,
  type HandleIncomingMessageOutput,
  handleIncomingMessage,
} from '../../application/conversation/HandleIncomingMessage.ts';
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

    // Map to text-only input
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
