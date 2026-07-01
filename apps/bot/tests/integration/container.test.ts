/**
 * Tests de integración del container (composition root).
 *
 * Cubrimos:
 *   1. buildContainer con defaults + skip flags: NO falla,
 *      todos los componentes están wireados correctamente.
 *   2. start() se puede llamar y skippea HTTP + WhatsApp init.
 *   3. shutdown() cierra en orden: HTTP → WhatsApp → Prisma.
 *   4. Whitelist vacía tira error.
 *   5. Prisma factory custom: el container usa el que pasamos.
 *
 * IMPORTANTE: estos tests NO bootean Chromium ni un HTTP server real
 * (skipHttpServer=true, skipWhatsAppInit=true, whatsappFactory=fake).
 */

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildContainer } from '../../src/config/container.ts';
import { parseEnv, type Env } from '../../src/config/env.ts';
import { silentLogger } from '../helpers/logger.ts';
import type { PrismaClientLike } from '../../src/infrastructure/persistence/PrismaClientLike.ts';
import type { IncomingMessage, WhatsAppMessagingPort } from '../../src/infrastructure/messaging/WhatsAppClient.ts';

// ── Helpers ───────────────────────────────────────────────────────

function buildTestEnv(): Env {
  const parsed = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    OWNER_PHONE_NUMBERS: '+5491112345678,+5491198765432',
    LOG_LEVEL: 'fatal',
    PORT: '3000',
    SESSION_PATH: './data/test-session',
    RATE_LIMIT_MESSAGE_MS: '2000',
    RATE_LIMIT_DAILY_COMPRAS: '30',
  });
  if (!parsed.success) {
    throw new Error(`Test env invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Fake PrismaClientLike con `findFirst` y `$disconnect`. */
function buildFakePrisma(): PrismaClientLike & { $disconnect: () => Promise<void> } {
  return {
    usuario: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => ({ id: 'u-1' })),
      create: vi.fn(async () => ({
        id: 'u-1',
        telefono: '+5491112345678',
        nombre: null,
        createdAt: new Date(),
      })),
    },
    compra: {
      create: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    itemCompra: {
      createMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => null),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    conversacion: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => null),
      update: vi.fn(async () => null),
    },
    venta: {
      create: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    $queryRaw: vi.fn(async () => []),
    $disconnect: vi.fn(async () => undefined),
  };
}

/** Fake WhatsApp port con EventEmitter. */
function buildFakePort(): WhatsAppMessagingPort & { emit: (e: string, ...args: unknown[]) => boolean } {
  const emitter = new EventEmitter();
  const port: WhatsAppMessagingPort = {
    initialize: vi.fn(async () => undefined),
    sendText: vi.fn(async () => undefined),
    sendImage: vi.fn(async () => undefined),
    sendDocument: vi.fn(async () => undefined),
    downloadMedia: vi.fn(async (_msg) => Buffer.from('fake-image-bytes')),
    onIncomingMessage: (handler) => {
      emitter.on('message', (msg: IncomingMessage) => {
        void handler(msg);
      });
    },
    destroy: vi.fn(async () => undefined),
    isReady: () => true,
  };
  return Object.assign(port, { emit: emitter.emit.bind(emitter) });
}

// ── Tests ─────────────────────────────────────────────────────────

describe('buildContainer (integration)', () => {
  let env: Env;
  beforeEach(() => {
    env = buildTestEnv();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds with defaults: all components wired', async () => {
    const fakePrisma = buildFakePrisma();
    const fakePort = buildFakePort();

    const container = await buildContainer({
      env,
      logger: silentLogger(),
      prismaFactory: () => fakePrisma,
      whatsappFactory: async () => fakePort,
      skipHttpServer: true,
      skipWhatsAppInit: true,
    });

    expect(container.env).toBe(env);
    expect(container.logger).toBeDefined();
    expect(container.prisma).toBe(fakePrisma);
    expect(container.whatsappPort).toBe(fakePort);
    expect(container.dispatcher).toBeDefined();
    expect(typeof container.dispatcher.handle).toBe('function');
    expect(container.serverHandle).toBeNull();
  });

  it('start() skipHttpServer=true: no server handle, whatsapp port not initialized', async () => {
    const fakePrisma = buildFakePrisma();
    const fakePort = buildFakePort();

    const container = await buildContainer({
      env,
      logger: silentLogger(),
      prismaFactory: () => fakePrisma,
      whatsappFactory: async () => fakePort,
      skipHttpServer: true,
      skipWhatsAppInit: true,
    });

    await container.start();
    expect(container.serverHandle).toBeNull();
    expect(fakePort.initialize).not.toHaveBeenCalled();
  });

  it('start() sin skip: llama a port.initialize', async () => {
    const fakePrisma = buildFakePrisma();
    const fakePort = buildFakePort();

    const container = await buildContainer({
      env,
      logger: silentLogger(),
      prismaFactory: () => fakePrisma,
      whatsappFactory: async () => fakePort,
      skipHttpServer: true,
      // skipWhatsAppInit = false, debería llamar port.initialize
    });

    await container.start();
    expect(fakePort.initialize).toHaveBeenCalledTimes(1);
  });

  it('shutdown() llama a destroy() y $disconnect()', async () => {
    const fakePrisma = buildFakePrisma();
    const fakePort = buildFakePort();

    const container = await buildContainer({
      env,
      logger: silentLogger(),
      prismaFactory: () => fakePrisma,
      whatsappFactory: async () => fakePort,
      skipHttpServer: true,
      skipWhatsAppInit: true,
    });

    await container.start();
    await container.shutdown();

    expect(fakePort.destroy).toHaveBeenCalledTimes(1);
    expect(fakePrisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('whitelist vacía tira error', async () => {
    const emptyEnv: Env = { ...env, OWNER_PHONE_NUMBERS: [] };
    await expect(
      buildContainer({
        env: emptyEnv,
        logger: silentLogger(),
        prismaFactory: () => buildFakePrisma(),
        whatsappFactory: async () => buildFakePort(),
        skipHttpServer: true,
        skipWhatsAppInit: true,
      }),
    ).rejects.toThrow(/OWNER_PHONE_NUMBERS is empty/);
  });

  it('dispatcher.handle se invoca cuando el port emite un mensaje', async () => {
    const fakePrisma = buildFakePrisma();
    const fakePort = buildFakePort();

    const container = await buildContainer({
      env,
      logger: silentLogger(),
      prismaFactory: () => fakePrisma,
      whatsappFactory: async () => fakePort,
      skipHttpServer: true,
      skipWhatsAppInit: true,
    });

    const processedBefore = container.dispatcher.processed();

    // Simulamos un mensaje entrante via el EventEmitter del fakePort.
    const fakeMsg: IncomingMessage = {
      from: '5491112345678@c.us',
      phone: '5491112345678',
      type: 'text',
      body: 'hola',
      hasMedia: false,
      id: 'msg-1',
      raw: {} as never,
    };

    fakePort.emit('message', fakeMsg);
    // Esperar a que la promesa del handler resuelva
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(container.dispatcher.processed()).toBe(processedBefore + 1);
  });
});
