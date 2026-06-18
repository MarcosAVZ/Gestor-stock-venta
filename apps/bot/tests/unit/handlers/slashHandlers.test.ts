/**
 * Tests unitarios para slashHandlers (slash command dispatch — TDD RED→GREEN→REFACTOR).
 *
 * Verifica que handleSlashCommand despacha correctamente cada /comando
 * usando un HandlerContext mockeado.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConversationState } from '@compras-whatsapp/db';

import { handleSlashCommand } from '../../../src/application/handlers/slashHandlers.ts';
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
    ventaRepo: {} as any,
    prisma: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    ...overrides,
  };
}

// Mock listarProductos
vi.mock('../../../src/application/conversation/AgregarStock.ts', () => ({
  listarProductos: vi.fn(),
}));

// Mock listarProductosConStock
vi.mock('../../../src/application/conversation/Vender.ts', () => ({
  listarProductosConStock: vi.fn(),
}));

// ── Tests ───────────────────────────────────────────────────────────

describe('slashHandlers — handleSlashCommand', () => {
  describe('/nueva', () => {
    it('sets state to PREGUNTANDO_PRODUCTO and asks product', async () => {
      const ctx = buildMockCtx();
      const result = await handleSlashCommand({ type: 'nueva' }, ctx);
      expect(result.responses[0]).toMatch(/producto/i);
      expect(result.newState).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
      expect(result.rejected).toBe(false);
    });

    it('persists new state via conversacionRepo.update', async () => {
      const ctx = buildMockCtx();
      await handleSlashCommand({ type: 'nueva' }, ctx);
      expect(ctx.conversacionRepo.update).toHaveBeenCalledWith('user-1', {
        estado: ConversationState.PREGUNTANDO_PRODUCTO,
        datosTemporales: {},
      });
    });
  });

  describe('/agregar', () => {
    it('sets state to AGREGANDO_STOCK when products exist', async () => {
      const { listarProductos } = await import('../../../src/application/conversation/AgregarStock.ts');
      vi.mocked(listarProductos).mockResolvedValue([
        { indice: 1, nombre: 'medias', costoLote: 1200, precioVenta: 1500, unidad: 'PAR' },
      ]);
      const ctx = buildMockCtx();
      const result = await handleSlashCommand({ type: 'agregar' }, ctx);
      expect(result.newState).toBe(ConversationState.AGREGANDO_STOCK);
      expect(result.responses[0]).toContain('1. medias');
    });

    it('returns message when no products exist', async () => {
      const { listarProductos } = await import('../../../src/application/conversation/AgregarStock.ts');
      vi.mocked(listarProductos).mockResolvedValue([]);
      const ctx = buildMockCtx();
      const result = await handleSlashCommand({ type: 'agregar' }, ctx);
      expect(result.responses[0]).toMatch(/No tenés productos cargados/);
    });
  });

  describe('/editar', () => {
    it('sets state to AGREGANDO_STOCK with modo "editar"', async () => {
      const { listarProductos } = await import('../../../src/application/conversation/AgregarStock.ts');
      vi.mocked(listarProductos).mockResolvedValue([
        { indice: 1, nombre: 'medias', costoLote: 1200, precioVenta: 1500, unidad: 'PAR' },
      ]);
      const ctx = buildMockCtx();
      const result = await handleSlashCommand({ type: 'editar' }, ctx);
      expect(result.newState).toBe(ConversationState.AGREGANDO_STOCK);
      expect(result.responses[0]).toContain('editar');
    });
  });

  describe('/eliminar', () => {
    it('sets state to AGREGANDO_STOCK with modo "eliminar"', async () => {
      const { listarProductos } = await import('../../../src/application/conversation/AgregarStock.ts');
      vi.mocked(listarProductos).mockResolvedValue([
        { indice: 1, nombre: 'medias', costoLote: 1200, precioVenta: 1500, unidad: 'PAR' },
      ]);
      const ctx = buildMockCtx();
      const result = await handleSlashCommand({ type: 'eliminar' }, ctx);
      expect(result.newState).toBe(ConversationState.AGREGANDO_STOCK);
      expect(result.responses[0]).toContain('eliminar');
    });
  });

  describe('/ayuda', () => {
    it('returns help text without changing state', async () => {
      const ctx = buildMockCtx({ workingState: ConversationState.PREGUNTANDO_CANTIDAD });
      const result = await handleSlashCommand({ type: 'ayuda' }, ctx);
      expect(result.responses[0]).toMatch(/comandos|ayuda|nueva/i);
      expect(result.newState).toBe(ConversationState.PREGUNTANDO_CANTIDAD);
      expect(result.rejected).toBe(false);
    });

    it('does NOT call conversacionRepo.update', async () => {
      const ctx = buildMockCtx();
      await handleSlashCommand({ type: 'ayuda' }, ctx);
      expect(ctx.conversacionRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('/vender', () => {
    it('sets state to VENDIENDO_SELECCION when products have stock', async () => {
      const { listarProductosConStock } = await import('../../../src/application/conversation/Vender.ts');
      vi.mocked(listarProductosConStock).mockResolvedValue([
        { indice: 1, nombre: 'medias', stock: 80 },
      ]);
      const ctx = buildMockCtx();
      const result = await handleSlashCommand({ type: 'vender' }, ctx);
      expect(result.newState).toBe(ConversationState.VENDIENDO_SELECCION);
      expect(result.responses[0]).toContain('1. medias');
    });

    it('returns message when no products have stock', async () => {
      const { listarProductosConStock } = await import('../../../src/application/conversation/Vender.ts');
      vi.mocked(listarProductosConStock).mockResolvedValue([]);
      const ctx = buildMockCtx();
      const result = await handleSlashCommand({ type: 'vender' }, ctx);
      expect(result.responses[0]).toMatch(/No tenés productos con stock/);
    });
  });
});
