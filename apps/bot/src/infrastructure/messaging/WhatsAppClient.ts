/**
 * @compras-whatsapp/bot — WhatsAppClient wrapper.
 *
 * POR QUÉ ESTA ABSTRACCIÓN: whatsapp-web.js requiere Chromium vía
 * puppeteer, lo cual es pesado y NO se puede testear en CI sin
 * instalar un browser headless. Para mantener el código testeable,
 * el dominio de la app consume la INTERFACE `WhatsAppMessagingPort`,
 * no `WAWebJS.Client` directamente. Esto permite:
 *   1. Testear el dispatcher (task 3.8) con un mock que implemente
 *      el port — sin Chromium, sin red.
 *   2. Migrar a Baileys u otro adapter en el futuro cambiando solo
 *      el adapter concreto.
 *
 * El `WhatsAppWebJsAdapter` (concrete impl) es el único que importa
 * `whatsapp-web.js`. Si el import falla (puppeteer no instaló Chromium
 * en este host), el adapter igual se carga — la falla se produce solo
 * al instanciar `new WAWebJS.Client()`. El container maneja esto con
 * try/catch y un mensaje claro al operador.
 *
 * Eventos manejados (sdd-design obs#28 sección "WhatsApp client"):
 *   - `qr`:           se loggea; el user escanea desde el celu
 *   - `ready`:        sesión activa, bot operativo
 *   - `authenticated`: handshake completo
 *   - `auth_failure`: fallo de auth, requiere reintento manual
 *   - `disconnected`: bot desconectado, se intenta reconectar
 *   - `message`:      mensaje entrante → callback
 *
 * GRACEFUL SHUTDOWN: `destroy()` cierra la sesión limpiamente. El
 * container (task 3.10) llama esto en SIGTERM/SIGINT.
 */

import type { Logger } from 'pino';
import type { Client as WAWebJSClient, Message as WAWebJSMessage } from 'whatsapp-web.js';
import { logSecurityEvent } from '../logging/logger.ts';

// ── Port (interface) ────────────────────────────────────────────────

/** Mensaje entrante normalizado al formato del bot. */
export interface IncomingMessage {
  /** Phone del remitente en formato WhatsApp ID (`5491112345678@c.us`). */
  from: string;
  /** Phone "limpio" (solo dígitos, sin @c.us) para comparar con whitelist. */
  phone: string;
  /** Tipo: texto o imagen. */
  type: 'text' | 'image';
  /** Body del mensaje (solo si type=text). */
  body?: string;
  /** True si tiene media adjunta (imagen, video, etc.). */
  hasMedia: boolean;
  /** ID único del mensaje (para ack/correlación). */
  id: string;
  /** Mensaje crudo de whatsapp-web.js (escape hatch para download). */
  raw: WAWebJSMessage;
}

export type IncomingMessageHandler = (msg: IncomingMessage) => void | Promise<void>;

/**
 * Puerto que el dominio consume. NO depende de whatsapp-web.js.
 * El adapter concreto implementa este contrato contra la lib externa.
 */
export interface WhatsAppMessagingPort {
  /** Inicializa la sesión (puede pedir QR la primera vez). */
  initialize(): Promise<void>;
  /** Envía texto a un chat (phone en formato E.164: +5491112345678). */
  sendText(to: string, text: string): Promise<void>;
  /** Envía una imagen desde un path local a un chat. */
  sendImage(to: string, filePath: string, caption?: string): Promise<void>;
  /** Descarga la media de un mensaje y devuelve el buffer.
   *  PR4: el port ya NO escribe a disco — esa responsabilidad
   *  pasó a `LocalImageStorage` (ver `infrastructure/storage/`).
   *  Beneficios: el port es simétrico, testeable con mocks
   *  simples, y el storage tiene su propio owner. */
  downloadMedia(msg: WAWebJSMessage): Promise<Buffer>;
  /** Registra el handler para mensajes entrantes. */
  onIncomingMessage(handler: IncomingMessageHandler): void;
  /** Cierra la sesión limpiamente. */
  destroy(): Promise<void>;
  /** True si la sesión está autenticada y operativa. */
  isReady(): boolean;
}

// ── Adapter concreto: whatsapp-web.js ───────────────────────────────

/**
 * Configuración para el adapter de whatsapp-web.js.
 * El container la arma desde env (SESSION_PATH, etc.).
 */
export interface WhatsAppWebJsAdapterConfig {
  /** Path local donde persiste la sesión (LocalAuth). */
  sessionPath: string;
  /** Versión del cliente. `null` = default recomendado por la lib. */
  clientId?: string;
  /** Timeout para `destroy()` (ms). Default 10s. */
  destroyTimeoutMs?: number;
}

/**
 * Adapter concreto que envuelve `WAWebJS.Client`. Único archivo en
 * toda la app que importa `whatsapp-web.js`. Si esa lib se rompe o
 * queremos migrar a Baileys, este es el único punto a cambiar.
 */
export class WhatsAppWebJsAdapter implements WhatsAppMessagingPort {
  private readonly client: WAWebJSClient;
  private readonly logger: Logger;
  private readonly config: WhatsAppWebJsAdapterConfig;
  private readonly handlers: IncomingMessageHandler[] = [];
  private ready = false;
  private _destroyed = false;

  constructor(client: WAWebJSClient, config: WhatsAppWebJsAdapterConfig, logger: Logger) {
    this.client = client;
    this.config = config;
    this.logger = logger;
    this.attachEventHandlers();
  }

  async initialize(): Promise<void> {
    if (this._destroyed) {
      throw new Error('WhatsAppWebJsAdapter: cannot initialize a destroyed adapter');
    }
    // `initialize()` no es bloqueante: el cliente se conecta en background
    // y emite `qr` / `authenticated` / `ready` según corresponda.
    // Esperamos el primer evento `ready` o `auth_failure` con una race.
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onReady = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onAuthFailure = (msg: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`WhatsApp auth failure: ${msg}`));
      };
      const cleanup = (): void => {
        this.client.removeListener('ready', onReady);
        this.client.removeListener('auth_failure', onAuthFailure);
      };
      this.client.once('ready', onReady);
      this.client.once('auth_failure', onAuthFailure);
      this.client.initialize().catch((err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  async sendText(to: string, text: string): Promise<void> {
    this.assertReady();
    const chatId = this.toChatId(to);
    await this.client.sendMessage(chatId, text);
    this.logger.info(
      { event: 'whatsapp_message_sent', type: 'text', chatId, length: text.length },
      'message sent',
    );
  }

  async sendImage(to: string, filePath: string, caption?: string): Promise<void> {
    this.assertReady();
    const chatId = this.toChatId(to);
    const { MessageMedia } = await import('whatsapp-web.js');
    const media = await MessageMedia.fromFilePath(filePath);
    await this.client.sendMessage(chatId, media, { caption: caption ?? '' });
    this.logger.info(
      { event: 'whatsapp_message_sent', type: 'image', chatId, path: filePath },
      'image sent',
    );
  }

  async downloadMedia(msg: WAWebJSMessage): Promise<Buffer> {
    this.assertReady();
    // PR4 refactor: el port solo descarga y devuelve bytes. La
    // persistencia a disco la hace `LocalImageStorage` (inyectado
    // en el eventDispatcher). Esto desacopla la capa de mensajería
    // de la capa de filesystem.
    if (typeof msg.downloadMedia === 'function') {
      const media = await msg.downloadMedia();
      return Buffer.from(media.data, 'base64');
    }
    throw new Error('WhatsAppWebJsAdapter.downloadMedia: msg has no downloadMedia method');
  }

  onIncomingMessage(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }

  async destroy(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;
    this.ready = false;
    const timeoutMs = this.config.destroyTimeoutMs ?? 10_000;
    await Promise.race([
      this.client.destroy().catch((err: unknown) => {
        this.logger.warn(
          { event: 'whatsapp_destroy_error', err: err instanceof Error ? err.message : String(err) },
          'destroy raised an error (continuing)',
        );
      }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    this.logger.info({ event: 'whatsapp_destroyed' }, 'WhatsApp client destroyed');
  }

  isReady(): boolean {
    return this.ready && !this._destroyed;
  }

  // ── Privados ────────────────────────────────────────────────────

  private attachEventHandlers(): void {
    this.client.on('qr', (qr: string) => {
      logSecurityEvent(this.logger, 'whatsapp_qr_ready', { qrLength: qr.length });
      this.logger.info(
        { event: 'whatsapp_qr', qrLength: qr.length },
        'Scan the QR code from WhatsApp > Linked Devices',
      );
    });

    this.client.on('authenticated', () => {
      this.logger.info({ event: 'whatsapp_authenticated' }, 'session authenticated');
    });

    this.client.on('auth_failure', (msg: string) => {
      this.logger.error({ event: 'whatsapp_auth_failure', message: msg }, 'auth failure');
    });

    this.client.on('ready', () => {
      this.ready = true;
      this.logger.info({ event: 'whatsapp_ready' }, 'WhatsApp client ready');
    });

    this.client.on('disconnected', (reason: string) => {
      this.ready = false;
      logSecurityEvent(this.logger, 'whatsapp_disconnected', { reason });
      this.logger.warn({ event: 'whatsapp_disconnected', reason }, 'client disconnected');
    });

    this.client.on('message', (msg: WAWebJSMessage) => {
      void this.dispatchMessage(msg);
    });
  }

  private async dispatchMessage(msg: WAWebJSMessage): Promise<void> {
    try {
      // Filtrar mensajes propios (fromMe=true), grupos y statuses.
      // MVP: solo DMs. Los grupos vienen con sufijo @g.us, los
      // statuses con @broadcast o @status.
      if (msg.fromMe) return;
      if (msg.isStatus) return;
      // whatsapp-web.js no expone isGroupMsg como propiedad del
      // Message tipado, pero el `from` siempre trae el sufijo:
      //   - "@c.us" para contactos individuales
      //   - "@g.us" para grupos
      //   - "@broadcast" o "@status" para statuses / listas
      const from = msg.from ?? '';
      if (from.includes('@g.us')) return;
      if (from.includes('@broadcast')) return;

      const phone = from.split('@')[0] ?? from;
      const hasMedia = Boolean(msg.hasMedia);
      const type: 'text' | 'image' = hasMedia ? 'image' : 'text';
      const incoming: IncomingMessage = {
        from,
        phone,
        type,
        body: msg.body,
        hasMedia,
        id: msg.id._serialized,
        raw: msg,
      };
      for (const handler of this.handlers) {
        try {
          await handler(incoming);
        } catch (err) {
          this.logger.error(
            {
              event: 'incoming_message_handler_error',
              err: err instanceof Error ? err.message : String(err),
              msgId: incoming.id,
            },
            'handler threw (continuing)',
          );
        }
      }
    } catch (err) {
      this.logger.error(
        { event: 'incoming_message_dispatch_error', err: err instanceof Error ? err.message : String(err) },
        'failed to dispatch incoming message',
      );
    }
  }

  private toChatId(phone: string): string {
    // E.164 "+5491112345678" → WhatsApp "5491112345678@c.us"
    const digits = phone.replace(/^\+/, '').replace(/\D/g, '');
    return `${digits}@c.us`;
  }

  private assertReady(): void {
    if (!this.isReady()) {
      throw new Error('WhatsAppWebJsAdapter: client not ready (or destroyed)');
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Construye el adapter de whatsapp-web.js con un `WAWebJS.Client`
 * configurado para LocalAuth. Esta función se llama SOLO desde el
 * container (task 3.10) — el resto de la app consume el port.
 *
 * El import dinámico de `whatsapp-web.js` es defensivo: si la lib
 * falla a cargar (puppeteer/Chromium faltante en host de CI), el
 * container captura y reporta un mensaje claro al operador.
 */
export async function buildWhatsAppAdapter(
  config: WhatsAppWebJsAdapterConfig,
  logger: Logger,
): Promise<WhatsAppWebJsAdapter> {
  // Import dinámico para que el adapter pueda existir en módulos
  // testeados sin que la lib se cargue hasta este punto.
  const waModule = await import('whatsapp-web.js');
  const { Client, LocalAuth } = waModule;
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: config.clientId ?? 'sgcw-bot', dataPath: config.sessionPath }),
    puppeteer: {
      headless: true,
      // Sin `executablePath`: usa el Chromium que puppeteer descargó
      // en `node_modules/.pnpm/puppeteer*/.local-chromium/`. Si el
      // host no tiene display ni Chromium, el container maneja el error.
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });
  return new WhatsAppWebJsAdapter(client, config, logger);
}
