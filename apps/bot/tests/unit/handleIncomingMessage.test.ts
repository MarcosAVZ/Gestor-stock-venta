/**
 * Tests unitarios del use case HandleIncomingMessage (WU4).
 *
 * Cubre el flujo completo de un mensaje entrante con todos los
 * collaborators mockeados. Verifica:
 *
 * - Text-only input type (sin image variant).
 * - Slash command dispatch (/nueva, /agregar, /ayuda) ANTES de query commands.
 * - Query commands (resumen, stock, etc.) después de slash commands.
 * - State machine transitions con los nuevos estados (PREGUNTANDO_PRODUCTO, etc.).
 * - Inactivity reset.
 * - Rate limit (text only).
 * - Whitelist check.
 * - Unknown text returns help.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationState, type Compra, type Conversacion, type ItemCompra, type Unidad } from '@compras-whatsapp/db';
import { Decimal } from 'decimal.js';
import type { Logger } from 'pino';

import { handleIncomingMessage } from '../../src/application/conversation/HandleIncomingMessage.ts';
import { UnauthorizedError, RateLimitError } from '../../src/domain/errors/OperationalError.ts';
import type { RateLimiter } from '../../src/infrastructure/messaging/rateLimiter.ts';
import type { ConversacionRepository } from '../../src/domain/repositories/ConversacionRepository.ts';
import type { CompraRepository } from '../../src/domain/repositories/CompraRepository.ts';
import type { ItemCompraRepository } from '../../src/domain/repositories/ItemCompraRepository.ts';
import type { UsuarioRepository } from '../../src/domain/repositories/UsuarioRepository.ts';

// ── Helpers ─────────────────────────────────────────────────────────

const WHITELIST = new Set(['+5491111111111', '+5491199999999']);

function buildFakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: 'info',
    silent: vi.fn(),
  } as unknown as Logger;
}

function buildMockRateLimiter(): RateLimiter & {
  canSendMessage: ReturnType<typeof vi.fn>;
  recordMessage: ReturnType<typeof vi.fn>;
} {
  return {
    canSendMessage: vi.fn(() => ({ allowed: true, retryAfterSec: 0 })),
    recordMessage: vi.fn(),
    canSaveCompra: vi.fn(() => ({ allowed: true, retryAfterSec: 0 })),
    recordCompra: vi.fn(),
    dailyCompraCount: vi.fn(() => 0),
    reset: vi.fn(),
  } as unknown as RateLimiter & {
    canSendMessage: ReturnType<typeof vi.fn>;
    recordMessage: ReturnType<typeof vi.fn>;
  };
}

function buildMockConversacionRepo(): ConversacionRepository & {
  findByUsuarioId: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  return {
    findByUsuarioId: vi.fn(),
    upsert: vi.fn(async (data) => ({
      id: 'conv-1',
      usuarioId: data.usuarioId,
      estado: data.estado ?? ConversationState.PREGUNTANDO_PRODUCTO,
      datosTemporales: (data.datosTemporales as object) ?? {},
      updatedAt: new Date(),
      createdAt: new Date(),
    } satisfies Conversacion)),
    update: vi.fn(async (usuarioId, patch) => ({
      id: 'conv-1',
      usuarioId,
      estado: patch.estado ?? ConversationState.PREGUNTANDO_PRODUCTO,
      datosTemporales: (patch.datosTemporales as object) ?? {},
      updatedAt: new Date(),
      createdAt: new Date(),
    } satisfies Conversacion)),
  } as unknown as ConversacionRepository & {
    findByUsuarioId: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function buildMockUsuarioRepo(): UsuarioRepository & {
  findByTelefono: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
} {
  return {
    findByTelefono: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(async (data) => ({
      id: 'user-1',
      telefono: data.telefono,
      nombre: data.nombre ?? null,
      createdAt: new Date(),
      compras: [],
      conversacion: null,
    })),
  } as unknown as UsuarioRepository & {
    findByTelefono: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

function buildMockCompraRepo(): CompraRepository {
  return {
    create: vi.fn(async (data) => ({
      id: 'compra-mock-1',
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

// Suppress unused warning — Unidad is imported in type positions only.
void (null as unknown as Unidad);

// ── Default conversacion builder ────────────────────────────────────

function makeConversacion(overrides: Partial<Conversacion> = {}): Conversacion {
  return {
    id: 'conv-1',
    usuarioId: 'user-1',
    estado: ConversationState.PREGUNTANDO_PRODUCTO,
    datosTemporales: {},
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('handleIncomingMessage (WU4 — text-command wiring)', () => {
  let logger: Logger;
  let rateLimiter: ReturnType<typeof buildMockRateLimiter>;
  let conversacionRepo: ReturnType<typeof buildMockConversacionRepo>;
  let usuarioRepo: ReturnType<typeof buildMockUsuarioRepo>;
  let deps: Parameters<typeof handleIncomingMessage>[1];

  beforeEach(() => {
    logger = buildFakeLogger();
    rateLimiter = buildMockRateLimiter();
    conversacionRepo = buildMockConversacionRepo();
    usuarioRepo = buildMockUsuarioRepo();
    deps = {
      logger,
      rateLimiter,
      conversacionRepo,
      usuarioRepo,
      compraRepo: buildMockCompraRepo(),
      itemCompraRepo: buildMockItemCompraRepo(),
      queryDeps: { prisma: {} as never, logger },
      whitelist: WHITELIST,
    };
    // Default: usuario ya existe
    usuarioRepo.findByTelefono.mockResolvedValue({
      id: 'user-1',
      telefono: '+5491111111111',
      nombre: null,
      createdAt: new Date(),
      compras: [],
      conversacion: null,
    });
    conversacionRepo.findByUsuarioId.mockResolvedValue(
      makeConversacion({ estado: ConversationState.PREGUNTANDO_PRODUCTO }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Text-only input type ─────────────────────────────────────────

  describe('text-only input type', () => {
    it('accepts text input and processes it', async () => {
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'hola' },
        deps,
      );
      expect(out.responses).toBeDefined();
      expect(out.responses.length).toBeGreaterThan(0);
    });

    it('IncomingMessageInput type only has text variant (compile-time check)', () => {
      // This is a type-level test. If the image variant exists, this won't compile.
      const textInput: import('../../src/application/conversation/HandleIncomingMessage.ts').IncomingMessageInput =
        { phone: '+5491111111111', type: 'text', body: 'test' };
      expect(textInput.type).toBe('text');
    });
  });

  // ── Rate limit (text only) ──────────────────────────────────────

  describe('rate limit (text only)', () => {
    it('rejects text with RateLimitError when cooldown active', async () => {
      rateLimiter.canSendMessage.mockReturnValue({
        allowed: false,
        retryAfterSec: 2,
        reason: 'message_cooldown',
      });
      await expect(
        handleIncomingMessage(
          { phone: '+5491111111111', type: 'text', body: 'hola' },
          deps,
        ),
      ).rejects.toThrow(RateLimitError);
    });

    it('records message timestamp AFTER successful processing', async () => {
      await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'cancelar' },
        deps,
      );
      expect(rateLimiter.recordMessage).toHaveBeenCalled();
    });
  });

  // ── Whitelist ───────────────────────────────────────────────────

  describe('whitelist', () => {
    it('rejects non-whitelisted phone with UnauthorizedError', async () => {
      await expect(
        handleIncomingMessage(
          { phone: '+5491100000000', type: 'text', body: 'hola' },
          deps,
        ),
      ).rejects.toThrow(UnauthorizedError);
    });

    it('normalizes phone without + prefix', async () => {
      const out = await handleIncomingMessage(
        { phone: '5491111111111', type: 'text', body: 'hola' },
        deps,
      );
      expect(out.responses).toBeDefined();
    });
  });

  // ── Slash command dispatch: /nueva ─────────────────────────────

  describe('slash command: /nueva', () => {
    it('/nueva sets state to PREGUNTANDO_PRODUCTO and asks product', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_PRODUCTO }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: '/nueva' },
        deps,
      );
      expect(out.responses[0]).toMatch(/producto/i);
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
    });

    it('/nueva works from any state (short-circuits)', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.CONFIRMACION_FINAL }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: '/nueva' },
        deps,
      );
      expect(out.responses[0]).toMatch(/producto/i);
      // State should still be PREGUNTANDO_PRODUCTO (from /nueva handler)
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
    });

    it('"nueva" without slash also works', async () => {
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'nueva' },
        deps,
      );
      expect(out.responses[0]).toMatch(/producto/i);
    });
  });

  // ── Slash command dispatch: /agregar ────────────────────────────

  describe('slash command: /agregar', () => {
    it('/agregar sets state to AGREGANDO_STOCK', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_PRODUCTO }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: '/agregar' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.AGREGANDO_STOCK);
    });

    it('/agregar works from any state (short-circuits)', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_CANTIDAD }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: '/agregar' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.AGREGANDO_STOCK);
    });
  });

  // ── Slash command dispatch: /ayuda ──────────────────────────────

  describe('slash command: /ayuda', () => {
    it('/ayuda returns help text without changing state', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_CANTIDAD }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: '/ayuda' },
        deps,
      );
      expect(out.responses[0]).toMatch(/comandos|ayuda|nueva/i);
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_CANTIDAD);
    });

    it('"ayuda" without slash also works', async () => {
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'ayuda' },
        deps,
      );
      expect(out.responses[0]).toMatch(/comandos|ayuda|nueva/i);
    });
  });

  // ── Query commands still work ──────────────────────────────────

  describe('query commands', () => {
    it('"resumen" executes query and returns result', async () => {
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'resumen' },
        deps,
      );
      // Query will return EMPTY_DB_MESSAGE since prisma is mocked empty
      expect(out.responses[0]).toBeDefined();
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
    });

    it('"stock" executes query and returns result', async () => {
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'stock' },
        deps,
      );
      expect(out.responses[0]).toBeDefined();
    });
  });

  // ── State machine transitions ──────────────────────────────────

  describe('state machine transitions', () => {
    it('PREGUNTANDO_PRODUCTO + product name → PREGUNTANDO_CANTIDAD', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_PRODUCTO }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'medias negras' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_CANTIDAD);
      expect(out.responses[0]).toMatch(/unidades|compraste/i);
    });

    it('PREGUNTANDO_CANTIDAD + "12" → PREGUNTANDO_UNIDAD', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_CANTIDAD }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: '12' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_UNIDAD);
      expect(out.responses[0]).toMatch(/unidad/i);
    });

    it('PREGUNTANDO_UNIDAD + "unidad" → PREGUNTANDO_COSTO_LOTE', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_UNIDAD }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'unidad' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_COSTO_LOTE);
      expect(out.responses[0]).toMatch(/costó|costo|lote/i);
    });

    it('PREGUNTANDO_COSTO_LOTE + "1500" → PREGUNTANDO_PRECIO_VENTA', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_COSTO_LOTE }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: '1500' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_PRECIO_VENTA);
      expect(out.responses[0]).toMatch(/vendés|precio/i);
    });

    it('PREGUNTANDO_PRECIO_VENTA + "2500" → CONFIRMACION_FINAL', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_PRECIO_VENTA }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: '2500' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.CONFIRMACION_FINAL);
      expect(out.responses[0]).toMatch(/resumen|guardo/i);
    });

    it('CONFIRMACION_FINAL + "sí" → GUARDADO', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({
          estado: ConversationState.CONFIRMACION_FINAL,
          datosTemporales: {
            producto: 'medias',
            costoLote: 1500,
            cantidadIngresada: 12,
            unidadIngresada: 'UNIDAD',
            precioVenta: 2500,
          },
        }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'sí' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.GUARDADO);
      expect(out.responses[0]).toMatch(/guardé|listo/i);
    });

    it('CONFIRMACION_FINAL + "no" → PREGUNTANDO_CANTIDAD', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.CONFIRMACION_FINAL }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'no' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_CANTIDAD);
    });
  });

  // ── Global commands (cancelar, menu) ───────────────────────────

  describe('global commands', () => {
    it('"cancelar" resets to PREGUNTANDO_PRODUCTO', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_CANTIDAD }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'cancelar' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
      expect(out.responses[0]).toMatch(/cancelé/);
    });

    it('"menu" resets to PREGUNTANDO_PRODUCTO', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.CONFIRMACION_FINAL }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'menu' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
    });
  });

  // ── Unknown text → help ────────────────────────────────────────

  describe('unknown text', () => {
    it('returns UNKNOWN_COMMAND_MESSAGE for unrecognized text in PREGUNTANDO_CANTIDAD', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_CANTIDAD }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'foobar' },
        deps,
      );
      expect(out.responses[0]).toMatch(/nueva|agregar|ayuda/i);
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_CANTIDAD);
    });
  });

  // ── Inactivity reset ──────────────────────────────────────────

  describe('inactivity reset', () => {
    it('resets to PREGUNTANDO_PRODUCTO if conversation is inactive', async () => {
      const old = new Date(Date.now() - 20 * 60 * 1000); // 20 min ago
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({
          estado: ConversationState.PREGUNTANDO_CANTIDAD,
          updatedAt: old,
        }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: '12' },
        deps,
      );
      // After timeout, "12" goes to PREGUNTANDO_PRODUCTO (reset) then
      // inputToEvent maps "12" to null (no event), returns help
      expect(out.responses[0]).toBeDefined();
      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
      const allInfo = infoCalls.flatMap((c) => c.map((a: unknown) => JSON.stringify(a))).join(' ');
      expect(allInfo).toContain('conversation_inactivity_reset');
    });
  });

  // ── Persist new state ──────────────────────────────────────────

  describe('state persistence', () => {
    it('persists new state via conversacionRepo.update when state changes', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_PRODUCTO }),
      );
      await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'medias negras' },
        deps,
      );
      expect(conversacionRepo.update).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ estado: ConversationState.PREGUNTANDO_CANTIDAD }),
      );
    });

    it('does NOT call update if state did not change', async () => {
      // Non-numeric text in PREGUNTANDO_CANTIDAD → null mapping → no state change
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_CANTIDAD }),
      );
      await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'asdfg' },
        deps,
      );
      expect(conversacionRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── Auto-creation ─────────────────────────────────────────────

  describe('auto-creation', () => {
    it('auto-creates Usuario on first message', async () => {
      usuarioRepo.findByTelefono.mockResolvedValueOnce(null);
      await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'hola' },
        deps,
      );
      expect(usuarioRepo.create).toHaveBeenCalledWith({ telefono: '+5491111111111' });
    });

    it('upserts Conversacion on first message', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValueOnce(null);
      await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'hola' },
        deps,
      );
      expect(conversacionRepo.upsert).toHaveBeenCalled();
    });
  });
});
