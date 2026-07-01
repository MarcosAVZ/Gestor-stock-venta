/**
 * Tests unitarios para vender handler (T4.3 — RED).
 *
 * Verifica que el handler de /vender:
 * - Lista productos con stock
 * - Cambia estado a VENDIENDO_SELECCION
 * - Retorna mensaje de selección
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConversationState } from '@compras-whatsapp/db';

import { handleVender } from '../../../src/application/handlers/vender.ts';
import type { HandlerContext } from '../../../src/application/handlers/HandlerContext.ts';

// ── Mock factory ────────────────────────────────────────────────────

function buildMockCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    usuarioId: 'user-1',
    workingState: ConversationState.PREGUNTANDO_PRODUCTO,
    workingDatos: {},
    conversacionRepo: {
      findByUsuarioId: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    } as any,
    compraRepo: {} as any,
    itemCompraRepo: {} as any,
    ventaRepo: {
      create: vi.fn(),
      findByUsuarioId: vi.fn(),
      findByProductoNombre: vi.fn(),
      sumIngresos: vi.fn(),
      sumGananciaTotal: vi.fn(),
    } as any,
    prisma: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    exportService: { exportToFile: vi.fn(), exportAndSend: vi.fn() } as any,
    importService: { parse: vi.fn(), applyChanges: vi.fn() } as any,
    chatId: '5491112345678@c.us',
    ...overrides,
  };
}

// Mock Vender use case
vi.mock('../../../src/application/conversation/Vender.ts', () => ({
  listarProductosConStock: vi.fn(),
}));

// ── Tests ───────────────────────────────────────────────────────────

describe('vender handler — handleVender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists products with stock and sets state to VENDIENDO_SELECCION', async () => {
    const { listarProductosConStock } = await import('../../../src/application/conversation/Vender.ts');
    vi.mocked(listarProductosConStock).mockResolvedValue([
      { indice: 1, nombre: 'medias', stock: 80 },
      { indice: 2, nombre: 'bufandas', stock: 50 },
    ]);

    const ctx = buildMockCtx();
    const result = await handleVender(ctx);

    expect(result.newState).toBe(ConversationState.VENDIENDO_SELECCION);
    expect(result.rejected).toBe(false);
    expect(result.responses[0]).toContain('1. medias');
    expect(result.responses[0]).toContain('2. bufandas');
  });

  it('returns message when no products have stock', async () => {
    const { listarProductosConStock } = await import('../../../src/application/conversation/Vender.ts');
    vi.mocked(listarProductosConStock).mockResolvedValue([]);

    const ctx = buildMockCtx();
    const result = await handleVender(ctx);

    expect(result.newState).toBe(ctx.workingState);
    expect(result.rejected).toBe(false);
    expect(result.responses[0]).toMatch(/No tenés productos con stock/);
  });

  it('persists new state via conversacionRepo.update', async () => {
    const { listarProductosConStock } = await import('../../../src/application/conversation/Vender.ts');
    vi.mocked(listarProductosConStock).mockResolvedValue([
      { indice: 1, nombre: 'medias', stock: 80 },
    ]);

    const ctx = buildMockCtx();
    await handleVender(ctx);

    expect(ctx.conversacionRepo.update).toHaveBeenCalledWith('user-1', {
      estado: ConversationState.VENDIENDO_SELECCION,
      datosTemporales: { productosDisponibles: [{ indice: 1, nombre: 'medias', stock: 80 }] },
    });
  });
});
