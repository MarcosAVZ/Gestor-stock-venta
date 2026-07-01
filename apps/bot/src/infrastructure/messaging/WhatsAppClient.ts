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
  /** Tipo: texto, imagen o documento. */
  type: 'text' | 'image' | 'document';
  /** Body del mensaje (solo si type=text). */
  body?: string;
  /** True si tiene media adjunta (imagen, video, etc.). */
  hasMedia: boolean;
  /** MIME type del media adjunto (solo si type=document o image). */
  mimetype?: string;
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
  /** Envía un documento desde un path local a un chat. */
  sendDocument(to: string, filePath: string, options?: { filename?: string; caption?: string }): Promise<void>;
  /** Descarga la media de un mensaje y devuelve el buffer.
   *  PR4: el port ya NO escribe a disco — esa responsabilidad
   *  Beneficios: el port es simétrico, testeable con mocks
   *  simples. */
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
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          this.logger.warn('initialize timeout: ready event not received after 60s');
        }
      }, 60_000);
      const onReady = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        this.logger.info('initialize: ready event received');
        resolve();
      };
      const onAuthFailure = (msg: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
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
        clearTimeout(timeout);
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
    const { MessageMedia } = await import('whatsapp-web.js').then(m => m.default ?? m);
    const media = await MessageMedia.fromFilePath(filePath);
    await this.client.sendMessage(chatId, media, { caption: caption ?? '' });
    this.logger.info(
      { event: 'whatsapp_message_sent', type: 'image', chatId, path: filePath },
      'image sent',
    );
  }

  async sendDocument(
    to: string,
    filePath: string,
    options?: { filename?: string; caption?: string },
  ): Promise<void> {
    this.assertReady();
    const chatId = this.toChatId(to);
    const { MessageMedia } = await import('whatsapp-web.js').then(m => m.default ?? m);
    const media = MessageMedia.fromFilePath(filePath);
    media.filename = options?.filename ?? media.filename;
    await this.client.sendMessage(chatId, '', {
      media,
      sendMediaAsDocument: true,
      caption: options?.caption ?? '',
    });
    this.logger.info(
      { event: 'whatsapp_message_sent', type: 'document', chatId, path: filePath, filename: media.filename },
      'document sent',
    );
  }

  async downloadMedia(msg: WAWebJSMessage): Promise<Buffer> {
    this.assertReady();
    // El port solo descarga y devuelve bytes.
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
    // Debug: log ALL client events to diagnose ready issue.
    const debugEvents = ['qr', 'authenticated', 'auth_failure', 'ready', 'disconnected', 'message', 'loading_screen', 'browserqa'];
    for (const evt of debugEvents) {
      this.client.on(evt, (...args: unknown[]) => {
        this.logger.debug({ event: `client_${evt}`, args: args.length }, `client emitted: ${evt}`);
      });
    }

    this.client.on('qr', (qr: string) => {
      logSecurityEvent(this.logger, 'whatsapp_qr_ready', { qrLength: qr.length });
      this.logger.info(
        { event: 'whatsapp_qr', qrLength: qr.length },
        'Scan the QR code from WhatsApp > Linked Devices',
      );
      // Print QR to terminal so the operator can scan it.
      import('qrcode').then((qrLib) => {
        qrLib.toString(qr, { type: 'terminal', small: true }, (err: Error | null, url: string) => {
          if (!err) console.log(url);
        });
      }).catch(() => {
        this.logger.warn('qrcode not available, QR not printed to terminal');
      });
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

      // Resolve phone: WhatsApp linked devices may send @lid instead
      // of the real phone number. Try to get the real number via contact.
      let phone = from.split('@')[0] ?? from;
      this.logger.debug({ from, initialPhone: phone }, 'dispatchMessage: raw from');
      if (from.includes('@lid')) {
        try {
          const contact = await msg.getContact();
          this.logger.debug(
            { lid: from, contactNumber: contact?.number, contactId: contact?.id, contactName: contact?.name },
            'dispatchMessage: LID contact resolved',
          );
          if (contact?.number) {
            phone = contact.number;
            this.logger.info({ lid: from, resolvedPhone: phone }, 'resolved LID to phone number');
          }
        } catch (err) {
          this.logger.warn({ lid: from, err: (err as Error).message }, 'could not resolve LID');
        }
      }

      const hasMedia = Boolean(msg.hasMedia);
      // Use msg.type (MessageTypes enum: 'chat', 'image', 'document', etc.)
      // to distinguish between image and document.
      const rawType = (msg as { type?: string }).type ?? '';
      let type: 'text' | 'image' | 'document';
      if (rawType === 'document') {
        type = 'document';
      } else if (hasMedia || rawType === 'image') {
        type = 'image';
      } else {
        type = 'text';
      }
      // Attempt to read mimetype from the message (runtime property on
      // whatsapp-web.js Message, not always present in TS types).
      const mimetype = (msg as { mimetype?: string }).mimetype;
      const incoming: IncomingMessage = {
        from,
        phone,
        type,
        body: msg.body,
        hasMedia,
        mimetype,
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
    // If already a chat ID (contains @), use as-is (handles @lid, @c.us, @g.us).
    if (phone.includes('@')) return phone;
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
  const { Client, LocalAuth } = waModule.default ?? waModule;
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: config.clientId ?? 'sgcw-bot', dataPath: config.sessionPath }),
    puppeteer: {
      headless: true,
      // Sin `executablePath`: usa el Chromium que puppeteer descargó
      // en `node_modules/.pnpm/puppeteer*/.local-chromium/`. Si el
      // host no tiene display ni Chromium, el container maneja el error.
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
  });
  return new WhatsAppWebJsAdapter(client, config, logger);
}
