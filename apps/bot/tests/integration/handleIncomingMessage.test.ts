/**
 * Tests del use case HandleIncomingMessage.
 *
 * Cubre el flujo completo de un mensaje entrante con todos los
 * collaborators mockeados (rateLimiter, conversacionRepo, usuarioRepo,
 * logger). Cubre:
 *
 * - Whitelist (OWASP A01): phone no whitelisted → UnauthorizedError
 *   + log security 'unauthorized_access'.
 * - Rate limit (OWASP A04): cooldown imagen o texto → RateLimitError
 *   + log security 'rate_limit_hit'. Record DESPUÉS del éxito.
 * - Conversacion: upsert si no existe, carga si existe, persiste
 *   nuevo estado después de transition.
 * - Inactivity: si updatedAt viejo y estado != ESPERANDO_IMAGEN →
 *   reset forzado con TIMEOUT.
 * - State machine: input → event → transición → response.
 * - Comandos globales (cancelar, menu): desde cualquier estado.
 * - Estado no esperado (ej: texto en ESPERANDO_IMAGEN): responde
 *   genérico, no muta.
 * - Auto-creación de Usuario: primer mensaje crea el usuario.
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
  canSendImage: ReturnType<typeof vi.fn>;
  recordMessage: ReturnType<typeof vi.fn>;
  recordImage: ReturnType<typeof vi.fn>;
} {
  return {
    canSendMessage: vi.fn(() => ({ allowed: true, retryAfterSec: 0 })),
    canSendImage: vi.fn(() => ({ allowed: true, retryAfterSec: 0 })),
    recordMessage: vi.fn(),
    recordImage: vi.fn(),
    canSaveCompra: vi.fn(() => ({ allowed: true, retryAfterSec: 0 })),
    recordCompra: vi.fn(),
    dailyCompraCount: vi.fn(() => 0),
    reset: vi.fn(),
  } as unknown as RateLimiter & {
    canSendMessage: ReturnType<typeof vi.fn>;
    canSendImage: ReturnType<typeof vi.fn>;
    recordMessage: ReturnType<typeof vi.fn>;
    recordImage: ReturnType<typeof vi.fn>;
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
      estado: data.estado ?? ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: (data.datosTemporales as object) ?? {},
      updatedAt: new Date(),
      createdAt: new Date(),
    } satisfies Conversacion)),
    update: vi.fn(async (usuarioId, patch) => ({
      id: 'conv-1',
      usuarioId,
      estado: patch.estado ?? ConversationState.ESPERANDO_IMAGEN,
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

// Suppress unused warning — Unidad is imported in type positions only.
void (null as unknown as Unidad);

// ── Default conversacion builder ────────────────────────────────────

function makeConversacion(overrides: Partial<Conversacion> = {}): Conversacion {
  return {
    id: 'conv-1',
    usuarioId: 'user-1',
    estado: ConversationState.ESPERANDO_IMAGEN,
    datosTemporales: {},
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('handleIncomingMessage', () => {
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
      makeConversacion({ estado: ConversationState.ESPERANDO_IMAGEN }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('whitelist (OWASP A01)', () => {
    it('rejects non-whitelisted phone with UnauthorizedError', async () => {
      await expect(
        handleIncomingMessage(
          { phone: '+5491100000000', type: 'text', body: 'hola' },
          deps,
        ),
      ).rejects.toThrow(UnauthorizedError);
    });

    it('logs security event for unauthorized access', async () => {
      await expect(
        handleIncomingMessage(
          { phone: '+5491100000000', type: 'text', body: 'hola' },
          deps,
        ),
      ).rejects.toThrow();
      expect(logger.warn).toHaveBeenCalled();
      const calls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const allArgs = calls.flatMap((c) => c.map((a: unknown) => JSON.stringify(a))).join(' ');
      expect(allArgs).toContain('unauthorized_access');
    });

    it('accepts whitelisted phone with + prefix', async () => {
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'hola' },
        deps,
      );
      expect(out.responses).toBeDefined();
    });

    it('normalizes phone without + prefix to E.164 before whitelist check', async () => {
      // 5491111111111 sin +, pero está en el set con +. Debe aceptar.
      const out = await handleIncomingMessage(
        { phone: '5491111111111', type: 'text', body: 'hola' },
        deps,
      );
      expect(out.responses).toBeDefined();
    });
  });

  describe('rate limit (OWASP A04)', () => {
    it('rejects image with RateLimitError when cooldown active', async () => {
      rateLimiter.canSendImage.mockReturnValue({
        allowed: false,
        retryAfterSec: 7,
        reason: 'image_cooldown',
      });
      await expect(
        handleIncomingMessage(
          { phone: '+5491111111111', type: 'image', imagePath: '/tmp/x.jpg' },
          deps,
        ),
      ).rejects.toThrow(RateLimitError);
    });

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

    it('logs security event rate_limit_hit', async () => {
      rateLimiter.canSendImage.mockReturnValue({
        allowed: false,
        retryAfterSec: 5,
        reason: 'image_cooldown',
      });
      await expect(
        handleIncomingMessage(
          { phone: '+5491111111111', type: 'image', imagePath: '/tmp/x.jpg' },
          deps,
        ),
      ).rejects.toThrow();
      const calls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const allArgs = calls.flatMap((c) => c.map((a: unknown) => JSON.stringify(a))).join(' ');
      expect(allArgs).toContain('rate_limit_hit');
    });

    it('records image timestamp AFTER successful processing', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.ESPERANDO_IMAGEN }),
      );
      await handleIncomingMessage(
        { phone: '+5491111111111', type: 'image', imagePath: '/tmp/x.jpg' },
        deps,
      );
      expect(rateLimiter.recordImage).toHaveBeenCalled();
      expect(rateLimiter.recordMessage).not.toHaveBeenCalled();
    });

    it('does NOT record if the input was rejected (e.g. unauthorized)', async () => {
      await expect(
        handleIncomingMessage(
          { phone: '+5491100000000', type: 'image', imagePath: '/tmp/x.jpg' },
          deps,
        ),
      ).rejects.toThrow();
      expect(rateLimiter.recordImage).not.toHaveBeenCalled();
    });
  });

  describe('usuario + conversacion hydration', () => {
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

    it('reuses existing Conversacion', async () => {
      const existing = makeConversacion({ estado: ConversationState.PREGUNTANDO_CANTIDAD });
      conversacionRepo.findByUsuarioId.mockResolvedValue(existing);
      await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: '12' },
        deps,
      );
      expect(conversacionRepo.upsert).not.toHaveBeenCalled();
    });
  });

  describe('state machine integration', () => {
    it('ESPERANDO_IMAGEN + image → VALIDANDO_DATOS with DISPARAR_OCR response', async () => {
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'image', imagePath: '/tmp/x.jpg' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.VALIDANDO_DATOS);
      expect(out.rejected).toBe(false);
      expect(out.responses[0]).toMatch(/Procesando|Detecté/);
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

    it('VALIDANDO_DATOS + "sí" → PREGUNTANDO_CANTIDAD', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({
          estado: ConversationState.VALIDANDO_DATOS,
          datosTemporales: { producto: 'medias negras', costoLote: 1500 },
        }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'sí' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_CANTIDAD);
    });

    it('persists new state via conversacionRepo.update', async () => {
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'image', imagePath: '/tmp/x.jpg' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.VALIDANDO_DATOS);
      expect(conversacionRepo.update).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ estado: ConversationState.VALIDANDO_DATOS }),
      );
    });

    it('does NOT update if state did not change (rare; GUARDADO is the only case)', async () => {
      // Si el state machine retorna mismo estado (no debería pasar en
      // la tabla actual, pero el guard existe), no se llama update.
      // Lo testeamos indirectamente: inputToEvent retorna null en
      // ESPERANDO_IMAGEN con texto, lo que NO muta el state.
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'asdfg' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.ESPERANDO_IMAGEN);
      expect(conversacionRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('comandos globales (cualquier estado)', () => {
    it('"cancelar" desde cualquier estado → ESPERANDO_IMAGEN con mensaje', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_CANTIDAD }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'cancelar' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.ESPERANDO_IMAGEN);
      expect(out.responses[0]).toMatch(/cancelé/);
    });

    it('"menu" desde CONFIRMACION_FINAL → ESPERANDO_IMAGEN', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.CONFIRMACION_FINAL }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'menu' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.ESPERANDO_IMAGEN);
    });
  });

  describe('ESPERANDO_IMAGEN + texto (comando no implementado)', () => {
    it('responds con mensaje genérico sin mutar estado', async () => {
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'hola que tal' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.ESPERANDO_IMAGEN);
      expect(out.responses[0]).toMatch(/Por ahora|Comandos|pronto/);
      expect(conversacionRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('inactivity reset', () => {
    it('forces TIMEOUT transition if updatedAt is older than inactivityThreshold', async () => {
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
      // Primero el TIMEOUT resetea a ESPERANDO_IMAGEN, pero el
      // input "12" se procesa DESPUÉS contra el nuevo estado. Como
      // ESPERANDO_IMAGEN no procesa números, responde con null.
      expect(out.responses[0]).toBeDefined();
      // El log de inactivity debe haberse emitido
      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
      const allInfo = infoCalls.flatMap((c) => c.map((a: unknown) => JSON.stringify(a))).join(' ');
      expect(allInfo).toContain('conversation_inactivity_reset');
    });

    it('does NOT reset if updatedAt is fresh', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_CANTIDAD }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: '12' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_UNIDAD);
    });
  });

  describe('transición inválida → log security', () => {
    it('logs state_transition_invalid when state machine rejects', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({ estado: ConversationState.PREGUNTANDO_CANTIDAD }),
      );
      // "sí" en PREGUNTANDO_CANTIDAD no es un evento válido.
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'sí' },
        deps,
      );
      expect(out.rejected).toBe(true);
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const allWarn = warnCalls.flatMap((c) => c.map((a: unknown) => JSON.stringify(a))).join(' ');
      expect(allWarn).toContain('state_transition_invalid');
    });
  });

  describe('integración con learning (PR5 forward-compat)', () => {
    it('VALIDANDO_DATOS con cantidadSugerida + "sí" → PREGUNTANDO_PRECIO_VENTA (skip)', async () => {
      conversacionRepo.findByUsuarioId.mockResolvedValue(
        makeConversacion({
          estado: ConversationState.VALIDANDO_DATOS,
          datosTemporales: {
            producto: 'medias negras',
            costoLote: 1500,
            cantidadSugerida: 12,
            unidadSugerida: 'PAR',
          },
        }),
      );
      const out = await handleIncomingMessage(
        { phone: '+5491111111111', type: 'text', body: 'sí' },
        deps,
      );
      expect(out.newState).toBe(ConversationState.PREGUNTANDO_PRECIO_VENTA);
      expect(out.responses[0]).toMatch(/vendés/);
    });
  });
});
