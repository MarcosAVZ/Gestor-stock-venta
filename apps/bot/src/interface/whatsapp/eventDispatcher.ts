/**
 * @compras-whatsapp/bot — WhatsApp event dispatcher.
 *
 * POR QUÉ EXISTE: la lib `whatsapp-web.js` emite eventos crudos
 * (`message`, `qr`, `ready`, etc.) sobre el `Client`. El dominio de
 * la app NO quiere acoplarse a esos eventos: el adapter ya los
 * normaliza a `IncomingMessage` y los entrega al `onIncomingMessage`
 * handler (ver WhatsAppClient.ts). Este módulo conecta ese handler
 * al caso de uso `HandleIncomingMessage` y se encarga del I/O de
 * imágenes (descarga + persistencia) antes de pasarle el control al use case.
 *
 * RESPONSABILIDADES:
 *   1. Recibir `IncomingMessage` del adapter.
 *   2. Si es imagen: descargar el buffer (`port.downloadMedia`) y
 *      persistirlo vía `imageStorage.save(phone, buffer, ext)`.
 *   3. Llamar a `HandleIncomingMessage` con el input normalizado.
 *   4. Enviar las respuestas de vuelta al chat (text por cada string).
 *   5. Logging estructurado de todo el ciclo (A09 security events).
 *
 * NO HACE:
 *   - Validación de whitelist (eso es responsabilidad del use case).
 *   - Rate limiting (lo hace el use case).
 *   - Persistencia de Conversacion (lo hace el use case).
 *   - Persistencia de imágenes (eso es responsabilidad de
 *     `LocalImageStorage`, inyectado como dep).
 *
 * PR4: el port `downloadMedia` ahora retorna `Buffer` (PR3 retornaba
 * `string` con el path ya escrito). El dispatcher ya no llama a
 * `buildImagePath` ni `ensureImageDir` — eso se delega al storage.
 *
 * Esto es el "transport adapter" del lado de la aplicación: traduce
 * entre el puerto `WhatsAppMessagingPort` y el caso de uso. El
 * container (task 3.10) es el único que llama `buildEventDispatcher`.
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
import type { LocalImageStorage } from '../../infrastructure/storage/LocalImageStorage.ts';

// ── Tipos públicos ─────────────────────────────────────────────────

/** Configuración del dispatcher. */
export interface EventDispatcherConfig {
  /** Extensión usada para imágenes descargadas. */
  imageExtension?: string;
}

export interface EventDispatcherDeps extends HandleIncomingMessageDeps {
  port: WhatsAppMessagingPort;
  config: EventDispatcherConfig;
  /** Storage para persistir imágenes (PR4 refactor). */
  imageStorage: LocalImageStorage;
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
 *   1. Si el mensaje es imagen: download a disco, loggea path (A09).
 *   2. Mapea `IncomingMessage` → `IncomingMessageInput` del use case.
 *   3. Llama `handleIncomingMessage` con try/catch — NUNCA propaga
 *      excepciones hacia el adapter (eso crashearía el EventEmitter).
 *   4. Envía las respuestas al chat via `port.sendText`.
 *
 * Por qué try/catch interno: el use case lanza errores de dominio
 * (UnauthorizedError, RateLimitError) que él MISMO loggea como
 * security events. Si esos errores burbujearan al EventEmitter de
 * WAWebJS, este los re-emitiría como `error` y desconectaría la sesión.
 * Por eso los CATCHEAMOS acá y los loggeamos via `port.sendText` para
 * que el usuario sepa por qué no le respondimos.
 */
export function buildEventDispatcher(deps: EventDispatcherDeps): EventDispatcherHandle {
  // Separamos el port y la config del resto. `useCaseDeps` mantiene el
  // logger y todo lo que HandleIncomingMessage necesita.
  const { port, config, ...useCaseDeps } = deps;
  const logger = useCaseDeps.logger;
  const ext = config.imageExtension ?? 'jpg';
  let processedCount = 0;

  const handle: IncomingMessageHandler = async (msg) => {
    processedCount += 1;

    const phone = extractPhone(msg.from);
    const chatId = msg.from; // formato `<phone>@c.us` para sendText

    logger.debug(
      { msgId: msg.id, type: msg.type, hasMedia: msg.hasMedia, phone },
      'dispatcher: incoming message',
    );

    // 1. Si es imagen, descargar buffer + persistir vía imageStorage.
    let imagePath: string | undefined;
    if (msg.type === 'image' && msg.hasMedia) {
      try {
        // PR4: `downloadMedia` solo devuelve bytes; el storage
        // (inyectado) se encarga del path y la escritura.
        const buffer = await port.downloadMedia(msg.raw);
        imagePath = await deps.imageStorage.save(phone, buffer, ext);
        logSecurityEvent(logger, 'media_downloaded', { phone, imagePath });
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), phone },
          'dispatcher: media download failed',
        );
        await safeSendText(port, chatId, 'No pude bajar la foto. ¿La podés reenviar?');
        return;
      }
    }

    // 2. Mapear al input del use case.
    const input =
      msg.type === 'image' && imagePath !== undefined
        ? { phone, type: 'image' as const, imagePath }
        : { phone, type: 'text' as const, body: msg.body ?? '' };

    // 3. Llamar al use case con try/catch defensivo.
    let output: HandleIncomingMessageOutput;
    try {
      output = await handleIncomingMessage(input, useCaseDeps);
    } catch (err) {
      // El use case NO debería lanzar:Unauthorized/RateLimit las maneja
      // internamente y devuelve `rejected: true`. Pero si algo se escapa
      // (bug, OOM, Prisma disconnect), lo loggeamos y avisamos al user.
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

    // 4. Enviar respuestas al chat (best-effort, una por una).
    for (const response of output.responses) {
      const sent = await safeSendText(port, chatId, response);
      if (!sent) {
        // Si falla el envío de UNA respuesta, cortamos el loop para no
        // spamear logs. El user verá las primeras respuestas y el resto
        // se pierde — aceptable para MVP.
        break;
      }
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
 * NUNCA propaga la excepción: el dispatcher debe sobrevivir errores
 * de envío (PR4 los reintenta, este MVP solo loggea).
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

/** Logger dummy cuando el port no expone uno (no debería pasar, pero por seguridad). */
function safeLogger(): Logger {
  // Pino acepta `undefined` target en pino.final? No — devolvemos un
  // minimal logger. Como esto es un path de error raro, lo dejamos
  // con la API de pino (sin import estático para no crear ciclo).
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
