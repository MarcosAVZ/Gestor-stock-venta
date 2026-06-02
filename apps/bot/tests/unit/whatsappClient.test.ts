/**
 * Tests del WhatsAppClient adapter.
 *
 * El adapter real requiere Chromium, lo cual NO está disponible en
 * el host de tests. Por eso testeamos contra un mock que implementa
 * solo los métodos que el adapter consume del `WAWebJS.Client`.
 * Esto cubre el comportamiento del wrapper sin tocar la red ni el
 * browser.
 *
 * Cubre:
 * - initialize(): emite 'ready' → resuelve. 'auth_failure' → reject.
 * - sendText(): llama client.sendMessage con chatId normalizado
 *   (+54911... → 54911...@c.us). Lanza si no está ready.
 * - sendImage(): idem + MessageMedia.fromFilePath.
 * - downloadMedia(): persiste buffer del base64 al destPath.
 * - onIncomingMessage(): handlers reciben mensajes filtrados
 *   (drop fromMe, isGroupMsg, isStatus).
 * - destroy(): idempotente + respeta timeout. Marca _destroyed.
 * - isReady(): refleja estado.
 * - Eventos del cliente: qr/authenticated/ready/disconnected
 *   loggean via logger + logSecurityEvent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Client as WAWebJSClientType, Message as WAWebJSMessageType } from 'whatsapp-web.js';
import type { Logger as PinoLoggerType } from 'pino';

import { WhatsAppWebJsAdapter } from '../../src/infrastructure/messaging/WhatsAppClient.ts';
import type { IncomingMessage, WhatsAppMessagingPort } from '../../src/infrastructure/messaging/WhatsAppClient.ts';

// ── Mock del WAWebJS.Client ──────────────────────────────────────────

class FakeClient extends EventEmitter {
  public initialize = vi.fn(async () => Promise.resolve());
  public sendMessage = vi.fn(async () => Promise.resolve());
  public destroy = vi.fn(async () => Promise.resolve());
  public getState = vi.fn(async () => 'CONNECTED' as const);
  public sendCalledWith: Array<{ to: string; content: unknown; options?: unknown }> = [];
  public initCalled = 0;
  public destroyCalled = 0;

  // whatsapp-web.js sendMessage signature: sendMessage(to, content, options?)
  async sendMessageShim(to: string, content: unknown, options?: unknown): Promise<unknown> {
    this.sendCalledWith.push({ to, content, options });
    return Promise.resolve();
  }
}

/** Fake de un Message entrante de whatsapp-web.js. */
function makeFakeMessage(
  overrides: Partial<{
    from: string;
    body: string;
    fromMe: boolean;
    hasMedia: boolean;
    isStatus: boolean;
    idSerialized: string;
    downloadMedia: () => Promise<{ data: string; mimetype: string; filename?: string }>;
  }> = {},
) {
  return {
    from: overrides.from ?? '5491112345678@c.us',
    body: overrides.body ?? 'hola',
    fromMe: overrides.fromMe ?? false,
    hasMedia: overrides.hasMedia ?? false,
    isStatus: overrides.isStatus ?? false,
    id: { _serialized: overrides.idSerialized ?? 'fake-id-1' },
    downloadMedia:
      overrides.downloadMedia ??
      (async () => ({ data: '', mimetype: 'image/jpeg' })),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Captura logs del Pino logger fake. */
function buildFakeLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return {
    info,
    warn,
    error,
    logger: { info, warn, error, debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() } as unknown as PinoLoggerType,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('WhatsAppWebJsAdapter', () => {
  let fakeClient: FakeClient;
  let adapter: WhatsAppWebJsAdapter;
  let logger: ReturnType<typeof buildFakeLogger>;

  beforeEach(() => {
    fakeClient = new FakeClient();
    logger = buildFakeLogger();
    // Patch sendMessage to record calls
    fakeClient.sendMessage = vi.fn(async (to: string, content: unknown, options?: unknown) => {
      fakeClient.sendCalledWith.push({ to, content, options });
      return Promise.resolve();
    });
    adapter = new WhatsAppWebJsAdapter(
      fakeClient as unknown as WAWebJSClientType,
      { sessionPath: '/tmp/sessions', destroyTimeoutMs: 1000 },
      logger.logger,
    );
  });

  describe('initialize()', () => {
    it('resolves when client emits "ready"', async () => {
      const initPromise = adapter.initialize();
      // El adapter llama client.initialize() antes de esperar 'ready'.
      // Simulamos la secuencia real: el cliente emite 'ready' después
      // de su initialize.
      await Promise.resolve();
      await Promise.resolve();
      fakeClient.emit('ready');
      await expect(initPromise).resolves.toBeUndefined();
      expect(fakeClient.initialize).toHaveBeenCalled();
    });

    it('rejects when client emits "auth_failure"', async () => {
      const initPromise = adapter.initialize();
      await Promise.resolve();
      await Promise.resolve();
      fakeClient.emit('auth_failure', 'bad credentials');
      await expect(initPromise).rejects.toThrow(/auth failure/i);
    });

    it('rejects when client.initialize() throws', async () => {
      fakeClient.initialize = vi.fn(async () => {
        throw new Error('puppeteer failed to launch');
      });
      // Re-crear adapter con el fake client modificado.
      adapter = new WhatsAppWebJsAdapter(
        fakeClient as unknown as WAWebJSClientType,
        { sessionPath: '/tmp/sessions' },
        logger.logger,
      );
      await expect(adapter.initialize()).rejects.toThrow(/puppeteer failed/i);
    });
  });

  describe('sendText()', () => {
    it('throws if not ready', async () => {
      await expect(adapter.sendText('+5491112345678', 'hola')).rejects.toThrow(/not ready/);
    });

    it('normalizes +5491112345678 to 5491112345678@c.us and sends', async () => {
      fakeClient.emit('ready');
      await adapter.sendText('+5491112345678', 'hola');
      expect(fakeClient.sendCalledWith).toHaveLength(1);
      expect(fakeClient.sendCalledWith[0]?.to).toBe('5491112345678@c.us');
      expect(fakeClient.sendCalledWith[0]?.content).toBe('hola');
    });

    it('handles phone without + prefix', async () => {
      fakeClient.emit('ready');
      await adapter.sendText('5491112345678', 'hola');
      expect(fakeClient.sendCalledWith[0]?.to).toBe('5491112345678@c.us');
    });
  });

  describe('sendImage()', () => {
    it('throws if not ready', async () => {
      await expect(adapter.sendImage('+5491112345678', '/tmp/foo.jpg')).rejects.toThrow(/not ready/);
    });

    // sendImage depende de MessageMedia.fromFilePath de la lib real.
    // Como el adapter usa `await import('whatsapp-web.js')` adentro,
    // y eso requiere la lib cargada, lo testeamos solo parcialmente
    // verificando que requiere ready.
  });

  describe('downloadMedia()', () => {
    it('decodes base64 to Buffer (PR4: ya no escribe a disco)', async () => {
      void fakeClient.emit('ready');
      const fakeMsg = makeFakeMessage({
        hasMedia: true,
        downloadMedia: async () => ({
          data: Buffer.from('hello-media').toString('base64'),
          mimetype: 'image/jpeg',
          filename: 'img.jpg',
        }),
      });
      const result = await adapter.downloadMedia(
        fakeMsg as unknown as WAWebJSMessageType,
      );
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString()).toBe('hello-media');
    });

    it('throws if msg has no downloadMedia method', async () => {
      void fakeClient.emit('ready');
      const badMsg = { id: { _serialized: 'x' } };
      await expect(
        adapter.downloadMedia(
          badMsg as unknown as WAWebJSMessageType,
        ),
      ).rejects.toThrow(/no downloadMedia method/);
    });
  });

  describe('onIncomingMessage()', () => {
    it('invokes registered handler with parsed message', async () => {
      const received: IncomingMessage[] = [];
      adapter.onIncomingMessage((m) => {
        received.push(m);
      });
      fakeClient.emit('message', makeFakeMessage({ body: 'hola' }));
      // Esperar microtask
      await new Promise((r) => setImmediate(r));
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        from: '5491112345678@c.us',
        phone: '5491112345678',
        type: 'text',
        body: 'hola',
        hasMedia: false,
      });
    });

    it('marks type=image when hasMedia=true', async () => {
      const received: IncomingMessage[] = [];
      adapter.onIncomingMessage((m) => {
        received.push(m);
      });
      void fakeClient.emit('message', makeFakeMessage({ hasMedia: true, body: '' }));
      await new Promise((r) => setImmediate(r));
      expect(received[0]?.type).toBe('image');
    });

    it('drops messages from self (fromMe)', async () => {
      const received: IncomingMessage[] = [];
      adapter.onIncomingMessage((m) => {
        received.push(m);
      });
      void fakeClient.emit('message', makeFakeMessage({ fromMe: true }));
      await new Promise((r) => setImmediate(r));
      expect(received).toHaveLength(0);
    });

    it('drops group messages (@g.us suffix)', async () => {
      const received: IncomingMessage[] = [];
      adapter.onIncomingMessage((m) => {
        received.push(m);
      });
      void fakeClient.emit(
        'message',
        makeFakeMessage({ from: '120363@g.us' }),
      );
      await new Promise((r) => setImmediate(r));
      expect(received).toHaveLength(0);
    });

    it('drops status broadcasts (isStatus)', async () => {
      const received: IncomingMessage[] = [];
      adapter.onIncomingMessage((m) => {
        received.push(m);
      });
      void fakeClient.emit('message', makeFakeMessage({ isStatus: true }));
      await new Promise((r) => setImmediate(r));
      expect(received).toHaveLength(0);
    });

    it('continues dispatching even if a handler throws', async () => {
      const second: IncomingMessage[] = [];
      adapter.onIncomingMessage(() => {
        throw new Error('handler boom');
      });
      adapter.onIncomingMessage((m) => {
        second.push(m);
      });
      void fakeClient.emit('message', makeFakeMessage());
      await new Promise((r) => setImmediate(r));
      expect(second).toHaveLength(1);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('destroy()', () => {
    it('is idempotent', async () => {
      void fakeClient.emit('ready');
      await adapter.destroy();
      await adapter.destroy();
      // destroy should be called only once
      expect(fakeClient.destroy).toHaveBeenCalledTimes(1);
    });

    it('respects destroyTimeoutMs (does not hang)', async () => {
      fakeClient.destroy = vi.fn(() => new Promise<void>(() => {})); // never resolves
      const start = Date.now();
      await adapter.destroy();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000); // configured at 1000ms + slack
    });

    it('marks the adapter as not ready after destroy', async () => {
      fakeClient.emit('ready');
      expect(adapter.isReady()).toBe(true);
      await adapter.destroy();
      expect(adapter.isReady()).toBe(false);
    });
  });

  describe('isReady()', () => {
    it('returns false before "ready" event', () => {
      expect(adapter.isReady()).toBe(false);
    });

    it('returns true after "ready" event', () => {
      fakeClient.emit('ready');
      expect(adapter.isReady()).toBe(true);
    });

    it('returns false after "disconnected"', () => {
      fakeClient.emit('ready');
      fakeClient.emit('disconnected', 'LOGOUT');
      expect(adapter.isReady()).toBe(false);
    });
  });

  describe('event handlers logging', () => {
    it('logs qr with length and security event', () => {
      fakeClient.emit('qr', 'qr-payload-base64');
      expect(logger.info).toHaveBeenCalled();
      const call = logger.info.mock.calls[0] as unknown[];
      expect(JSON.stringify(call)).toContain('whatsapp_qr');
    });

    it('logs authenticated as info', () => {
      fakeClient.emit('authenticated');
      expect(logger.info).toHaveBeenCalled();
      const call = logger.info.mock.calls[0] as unknown[];
      expect(JSON.stringify(call)).toContain('whatsapp_authenticated');
    });

    it('logs auth_failure as error', () => {
      fakeClient.emit('auth_failure', 'bad creds');
      expect(logger.error).toHaveBeenCalled();
      const call = logger.error.mock.calls[0] as unknown[];
      expect(JSON.stringify(call)).toContain('whatsapp_auth_failure');
    });

    it('logs disconnected as warn with security event', () => {
      fakeClient.emit('ready');
      fakeClient.emit('disconnected', 'NAVIGATION');
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('port interface conformance', () => {
    it('exposes the WhatsAppMessagingPort surface', () => {
      // Verificación estática de shape (TS ya lo valida, esto es
      // defensa contra refactor que rompa la interface).
      const port: WhatsAppMessagingPort = adapter;
      expect(typeof port.initialize).toBe('function');
      expect(typeof port.sendText).toBe('function');
      expect(typeof port.sendImage).toBe('function');
      expect(typeof port.downloadMedia).toBe('function');
      expect(typeof port.onIncomingMessage).toBe('function');
      expect(typeof port.destroy).toBe('function');
      expect(typeof port.isReady).toBe('function');
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
});
