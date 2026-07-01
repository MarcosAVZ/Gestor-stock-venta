/**
 * Tests del EventDispatcher (WU4 — text-only).
 *
 * Cubrimos los paths críticos:
 *   1. Texto: pasa al use case, envía respuestas.
 *   2. Use case lanza excepción: catch defensivo, avisa al user.
 *   3. Port.sendText falla: loggea pero NO crashea (best-effort).
 *   4. Helper `extractPhone` (unit test puro).
 *   5. processedCount incrementa correctamente.
 *
 * Mocks:
 *   - `port`: fake que implementa `WhatsAppMessagingPort` con in-memory maps.
 *   - `use case deps`: mocks de Logger, RateLimiter, repos, etc.
 */

import type { Message as WAWebJSMessage } from 'whatsapp-web.js';
import { describe, expect, it, vi } from 'vitest';
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
  failNextSend: boolean;
}

function buildFakePort(): FakePort {
  const sentTexts = new Map<string, string[]>();
  let failNextSend = false;
  const port: FakePort = {
    sentTexts,
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
    sendDocument: async () => undefined,
    downloadMedia: async () => Buffer.from(''),
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
      estado: patch.estado ?? ConversationState.PREGUNTANDO_PRODUCTO,
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
    canSendMessage: () => ({ allowed: true, retryAfterSec: 0 }),
    canSendImage: () => ({ allowed: true, retryAfterSec: 0 }),
    canSaveCompra: () => ({ allowed: true, retryAfterSec: 0 }),
    recordMessage: () => undefined,
    recordImage: () => undefined,
    recordCompra: () => undefined,
    dailyCompraCount: () => 0,
    reset: () => undefined,
  } as unknown as RateLimiter;
}

function buildDeps(port: WhatsAppMessagingPort) {
  return {
    port,
    logger: silentLogger(),
    rateLimiter: buildMockRateLimiter(),
    conversacionRepo: buildMockConversacionRepo(null),
    usuarioRepo: buildMockUsuarioRepo('+5491112345678'),
    compraRepo: buildMockCompraRepo(),
    itemCompraRepo: buildMockItemCompraRepo(),
    ventaRepo: { create: vi.fn(), findByUsuarioId: vi.fn(), findByProductoNombre: vi.fn(), sumIngresos: vi.fn(), sumGananciaTotal: vi.fn() } as never,
    queryDeps: { prisma: buildMockPrisma() as never, logger: silentLogger() },
    whitelist: new Set(['+5491112345678']),
    exportService: { exportToFile: vi.fn(), exportAndSend: vi.fn() } as any,
    importService: { parse: vi.fn(), applyChanges: vi.fn() } as any,
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

// Mock importHandlers for document flow tests
vi.mock('../../src/application/handlers/importHandlers.ts', () => ({
  handleDocumentoRecibido: vi.fn(),
}));

// ── Tests del dispatcher ──────────────────────────────────────────

describe('EventDispatcher', () => {
  it('text message: passes body to use case, sends response', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port);
    const { handle } = buildEventDispatcher(deps);

    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.PREGUNTANDO_PRODUCTO,
      datosTemporales: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion));

    await handle(buildIncoming({ type: 'text', body: 'hola' }));

    expect(port.sentTexts.get('5491112345678@c.us')?.length ?? 0).toBeGreaterThan(0);
  });

  it('use case throws: catch defensivo, sends apology, does NOT propagate', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port);
    const { handle } = buildEventDispatcher(deps);

    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => {
      throw new Error('Prisma down');
    });

    await expect(handle(buildIncoming({ type: 'text', body: 'hola' }))).resolves.toBeUndefined();
    const sent = port.sentTexts.get('5491112345678@c.us') ?? [];
    expect(sent.some((s) => s.includes('error'))).toBe(true);
  });

  it('port.sendText fails: continues to next response, does NOT crash', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port);
    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.PREGUNTANDO_PRODUCTO,
      datosTemporales: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion));

    const { handle } = buildEventDispatcher(deps);
    port.failNextSend = true;

    await expect(handle(buildIncoming({ type: 'text', body: 'x' }))).resolves.toBeUndefined();
  });

  it('processed() counter increments per call', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port);
    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.PREGUNTANDO_PRODUCTO,
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

  it('text message with no body: passes empty string', async () => {
    const port = buildFakePort();
    const deps = buildDeps(port);
    deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
      id: 'conv-1',
      usuarioId: 'u-1',
      estado: ConversationState.PREGUNTANDO_PRODUCTO,
      datosTemporales: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } satisfies Conversacion));

    const { handle } = buildEventDispatcher(deps);
    await handle(buildIncoming({ type: 'text', body: undefined }));
    expect(port.sentTexts.has('5491112345678@c.us')).toBe(true);
  });

  // ── Document handling ────────────────────────────────────────────

  describe('document messages (import flow)', () => {
    it('routes Excel document to handleDocumentoRecibido when in IMPORTANDO_ESPERANDO_ARCHIVO', async () => {
      const { handleDocumentoRecibido } = await import('../../src/application/handlers/importHandlers.ts');
      vi.mocked(handleDocumentoRecibido).mockResolvedValue({
        responses: ['📋 Resumen...', '¿Aplico estos cambios? (sí/no)'],
        newState: ConversationState.IMPORTANDO_REVISANDO,
        rejected: false,
      });

      const port = buildFakePort();
      const deps = buildDeps(port);
      deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
        id: 'conv-1',
        usuarioId: 'u-1',
        estado: ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO,
        datosTemporales: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies Conversacion));

      const { handle } = buildEventDispatcher(deps);
      await handle(buildIncoming({
        type: 'document',
        hasMedia: true,
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body: '',
      }));

      const sent = port.sentTexts.get('5491112345678@c.us') ?? [];
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[0]).toContain('Resumen');
    });

    it('responds with error for non-Excel document in import state', async () => {
      const port = buildFakePort();
      const deps = buildDeps(port);
      deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
        id: 'conv-1',
        usuarioId: 'u-1',
        estado: ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO,
        datosTemporales: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies Conversacion));

      const { handle } = buildEventDispatcher(deps);
      await handle(buildIncoming({
        type: 'document',
        hasMedia: true,
        mimetype: 'image/png',
        body: '',
      }));

      const sent = port.sentTexts.get('5491112345678@c.us') ?? [];
      expect(sent.some((s) => s.includes('.xlsx'))).toBe(true);
    });

    it('forwards document body as text when not in import state', async () => {
      const port = buildFakePort();
      const deps = buildDeps(port);
      deps.conversacionRepo.findByUsuarioId = vi.fn(async () => ({
        id: 'conv-1',
        usuarioId: 'u-1',
        estado: ConversationState.PREGUNTANDO_PRODUCTO,
        datosTemporales: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies Conversacion));

      // The user is in PREGUNTANDO_PRODUCTO, so the document caption is treated as text
      const { handle } = buildEventDispatcher(deps);
      await handle(buildIncoming({
        type: 'document',
        hasMedia: true,
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body: 'hola',
      }));

      // Should have been processed as text via handleIncomingMessage
      const sent = port.sentTexts.get('5491112345678@c.us') ?? [];
      expect(sent.length).toBeGreaterThan(0);
    });
  });
});
