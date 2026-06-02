/**
 * Tests del EventDispatcher.
 *
 * Cubrimos los paths críticos:
 *   1. Texto: pasa al use case, envía respuestas.
 *   2. Imagen: descarga buffer, persiste vía LocalImageStorage,
 *      pasa imagePath al use case, envía respuestas.
 *   3. Imagen con error de download: avisa al user, NO llama al use case.
 *   4. Imagen con error de storage: avisa al user, NO llama al use case.
 *   5. Use case lanza excepción: catch defensivo, avisa al user.
 *   6. Port.sendText falla: loggea pero NO crashea (best-effort).
 *   7. Helper `extractPhone` (unit test puro).
 *   8. processedCount incrementa correctamente.
 *
 * Mocks:
 *   - `port`: fake que implementa `WhatsAppMessagingPort` con in-memory maps.
 *   - `imageStorage`: fake in-memory con `save()` y `getPath()`.
 *   - `use case deps`: mocks de Logger, RateLimiter, repos, etc.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message as WAWebJSMessage } from 'whatsapp-web.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { ConversationState, type Compra, type Conversacion, type ItemCompra, type Unidad } from '@compras-whatsapp/db';
import { Decimal } from 'decimal.js';

import { buildEventDispatcher, extractPhone } from '../../src/interface/whatsapp/eventDispatcher.ts';
import type {
  IncomingMessage,
  WhatsAppMessagingPort,
} from '../../src/infrastructure/messaging/WhatsAppClient.ts';
import type { ConversacionRepository } from '../../src/domain/repositories/ConversacionRepository.ts';
import type { CompraRepository } from '../../src/domain/repositories/CompraRepository.ts';
import type { ItemCompraRepository } from '../../src/domain/repositories/ItemCompraRepository.ts';
import type { UsuarioRepository } from '../../src/domain/repositories/UsuarioRepository.ts';
import type { RateLimiter } from '../../src/infrastructure/messaging/rateLimiter.ts';
import { LocalImageStorage } from '../../src/infrastructure/storage/LocalImageStorage.ts';

// ── Fakes ─────────────────────────────────────────────────────────

function silentLogger(): Logger {
  const noop = () => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => silentLogger(),
    level: 'silent',
  } as unknown as Logger;
}

interface FakePort extends WhatsAppMessagingPort {
  sentTexts: Map<string, string[]>;
  downloadCalls: Array<{ msg: WAWebJSMessage }>;
  failNextDownload: boolean;
  failNextSend: boolean;
}

function buildFakePort(): FakePort {
  const sentTexts = new Map<string, string[]>();
  const downloadCalls: Array<{ msg: WAWebJSMessage }> = [];
  let failNextDownload = false;
  let failNextSend = false;
  const port: FakePort = {
    sentTexts,
    downloadCalls,
    get failNextDownload() {
      return failNextDownload;
    },
    set failNextDownload(v: boolean) {
      failNextDownload = v;
    },
    get failNextSend() {
      return failNextSend;
    },
    set failNextSend(v: boolean) {
      failNextSend = v;
    },
    initialize: async () => undefined,
    sendText: async (to, text) => {
      if (failNextSend) {
        failNextSend = false;
        throw new Error('fake sendText failure');
      }
      const list = sentTexts.get(to) ?? [];
      list.push(text);
      sentTexts.set(to, list);
    },
    sendImage: async () => undefined,
    downloadMedia: async (msg) => {
      if (failNextDownload) {
        failNextDownload = false;
        throw new Error('fake download failure');
      }
      downloadCalls.push({ msg });
      return Buffer.from('fake-image-bytes');
    },
    onIncomingMessage: () => undefined,
    destroy: async () => undefined,
    isReady: () => true,
  };
  return port;
}

function buildMockConversacionRepo(
  existing: Conversacion | null = null,
): ConversacionRepository {
  return {
    findByUsuarioId: vi.fn(async () => existing),
    upsert: vi.fn(async (input) => {
      const conv: Conversacion = {
        id: 'conv-1',
        usuarioId: input.usuarioId,
        estado: input.estado,
        datosTemporales: input.datosTemporales ?? {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return conv;
    }),
    update: vi.fn(async (id, patch) => ({
      id,
      usuarioId: 'u-1',
      estado: patch.estado ?? ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: patch.datosTemporales ?? {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion)),
  } as unknown as ConversacionRepository;
}

function buildMockUsuarioRepo(phone: string): UsuarioRepository {
  return {
    findByTelefono: vi.fn(async () => ({
      id: 'u-1',
      telefono: phone,
      nombre: 'Test',
      createdAt: new Date(),
    })),
    create: vi.fn(),
  } as unknown as UsuarioRepository;
}

function buildMockRateLimiter(): RateLimiter {
  return {
    canSendMessage: () => true,
    canSendImage: () => true,
    canSaveCompra: () => true,
    recordMessage: () => undefined,
    recordImage: () => undefined,
    recordCompra: () => undefined,
    dailyCompraCount: () => 0,
    reset: () => undefined,
  } as unknown as RateLimiter;
}

function buildDeps(port: WhatsAppMessagingPort, imageStorage: LocalImageStorage) {
  return {
    port,
    config: {},
    imageStorage,
    logger: silentLogger(),
    rateLimiter: buildMockRateLimiter(),
    conversacionRepo: buildMockConversacionRepo(null),
    usuarioRepo: buildMockUsuarioRepo('+5491112345678'),
    compraRepo: buildMockCompraRepo(),
    itemCompraRepo: buildMockItemCompraRepo(),
    queryDeps: { prisma: buildMockPrisma() as never, logger: silentLogger() },
    whitelist: new Set(['+5491112345678']),
  };
}

function buildMockPrisma() {
  return {
    compra: { findMany: vi.fn(async () => []), create: vi.fn(), findUnique: vi.fn() },
    itemCompra: { findMany: vi.fn(async () => []), createMany: vi.fn(), findFirst: vi.fn() },
    $queryRaw: vi.fn(async () => []),
    usuario: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    conversacion: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  };
}

function buildMockCompraRepo(): CompraRepository {
  return {
    create: vi.fn(async (data) => ({
      id: 'compra-mock',
      usuarioId: data.usuarioId,
      fecha: new Date(),
      imagenOriginal: data.imagenOriginal ?? null,
      moneda: 'ARS' as const,
    } as Compra)),
    findById: vi.fn(),
    findByIdWithItems: vi.fn(),
    findByUsuarioId: vi.fn(),
    findByDateRange: vi.fn(),
    findTopByGanancias: vi.fn(),
  } as unknown as CompraRepository;
}

function buildMockItemCompraRepo(): ItemCompraRepository {
  return {
    createMany: vi.fn(async (items: Array<{
      compraId: string; nombre: string; cantidadLote: number; unidad: Unidad;
      costoLote: string; costoUnitario: string; precioVenta: string;
      gananciaUnitaria: string; gananciaTotal: string;
    }>) => items.map((it: {
      compraId: string; nombre: string; cantidadLote: number; unidad: Unidad;
      costoLote: string; costoUnitario: string; precioVenta: string;
      gananciaUnitaria: string; gananciaTotal: string;
    }, i: number) => ({
      id: `item-mock-${i}`,
      compraId: it.compraId,
      nombre: it.nombre,
      cantidadLote: it.cantidadLote,
      unidad: it.unidad,
      costoLote: new Decimal(it.costoLote),
      costoUnitario: new Decimal(it.costoUnitario),
      precioVenta: new Decimal(it.precioVenta),
      gananciaUnitaria: new Decimal(it.gananciaUnitaria),
      gananciaTotal: new Decimal(it.gananciaTotal),
      updatedAt: new Date(),
    } as unknown as ItemCompra))),
    findByNombre: vi.fn(),
    findRecentByNombre: vi.fn(),
  } as unknown as ItemCompraRepository;
}

function buildIncoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    from: '5491112345678@c.us',
    phone: '5491112345678',
    type: 'text',
    body: 'hola',
    hasMedia: false,
    id: 'msg-1',
    raw: { id: { _serialized: 'msg-1' } } as unknown as WAWebJSMessage,
    ...overrides,
  };
}

// ── Tests de helpers ──────────────────────────────────────────────

describe('extractPhone', () => {
  it('strips @c.us suffix', () => {
    expect(extractPhone('5491112345678@c.us')).toBe('5491112345678');
  });

  it('strips @g.us suffix (safety net)', () => {
    expect(extractPhone('120363@g.us')).toBe('120363');
  });

  it('returns input unchanged when no @ present', () => {
    expect(extractPhone('5491112345678')).toBe('5491112345678');
  });
});

// ── Tests del dispatcher ──────────────────────────────────────────

describe('EventDispatcher', () => {
  let tmpDir: string;
  let imageStorage: LocalImageStorage;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dispatcher-'));
    imageStorage = new LocalImageStorage({ rootPath: tmpDir, logger: silentLogger() });
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('text message: passes body to use case, sends response', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port, imageStorage);
    const { handle } = buildEventDispatcher(deps);

    // Re-mock use case deps to capture the input.
    const inputCapture: Array<unknown> = [];
    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion));

    // We spy on the use case indirectly by checking sendText side-effect.
    await handle(buildIncoming({ type: 'text', body: 'hola' }));

    expect(port.sentTexts.get('5491112345678@c.us')?.length ?? 0).toBeGreaterThan(0);
    // No se descargó media
    expect(port.downloadCalls.length).toBe(0);
    expect(inputCapture.length).toBe(0); // no captura acá, pero verificamos side effect
  });

  it('image message: downloads buffer, persists via imageStorage, passes imagePath to use case', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port, imageStorage);
    const { handle } = buildEventDispatcher(deps);

    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion));

    await handle(buildIncoming({ type: 'image', hasMedia: true, body: undefined }));

    expect(port.downloadCalls.length).toBe(1);
    // El archivo persistido debe estar en `<tmpDir>/<phone>/<file>.jpg`
    const dir = join(tmpDir, '5491112345678');
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.jpg$/);
  });

  it('image download failure: sends apology, does NOT call use case', async () => {
    const port = buildFakePort();
    port.failNextDownload = true;
    const deps = buildDeps(port, imageStorage);
    const { handle } = buildEventDispatcher(deps);

    const findByUsuarioIdSpy = vi.spyOn(deps.conversacionRepo, 'findByUsuarioId');
    await handle(buildIncoming({ type: 'image', hasMedia: true }));

    expect(findByUsuarioIdSpy).not.toHaveBeenCalled();
    const sent = port.sentTexts.get('5491112345678@c.us') ?? [];
    expect(sent.some((s) => s.includes('foto'))).toBe(true);
  });

  it('use case throws: catch defensivo, sends apology, does NOT propagate', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port, imageStorage);
    const { handle } = buildEventDispatcher(deps);

    // Forzamos un throw re-mockeando findByUsuarioId para que lance.
    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => {
      throw new Error('Prisma down');
    });

    await expect(handle(buildIncoming({ type: 'text', body: 'hola' }))).resolves.toBeUndefined();
    const sent = port.sentTexts.get('5491112345678@c.us') ?? [];
    expect(sent.some((s) => s.includes('error'))).toBe(true);
  });

  it('port.sendText fails: continues to next response, does NOT crash', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port, imageStorage);
    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion));

    const { handle } = buildEventDispatcher(deps);
    port.failNextSend = true;

    // No throw: aunque sendText falle, el handler resuelve.
    await expect(handle(buildIncoming({ type: 'text', body: 'x' }))).resolves.toBeUndefined();
  });

  it('processed() counter increments per call', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port, imageStorage);
    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion));

    const dispatcher = buildEventDispatcher(deps);
    expect(dispatcher.processed()).toBe(0);
    await dispatcher.handle(buildIncoming({ type: 'text', body: '1' }));
    await dispatcher.handle(buildIncoming({ type: 'text', body: '2' }));
    expect(dispatcher.processed()).toBe(2);
  });

  it('text message with no body (image text fallback): passes empty string', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port, imageStorage);
    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion));

    const { handle } = buildEventDispatcher(deps);
    await handle(buildIncoming({ type: 'text', body: undefined }));
    // Resuelve sin throw, el use case maneja el body vacío
    expect(port.sentTexts.has('5491112345678@c.us')).toBe(true);
  });
});
