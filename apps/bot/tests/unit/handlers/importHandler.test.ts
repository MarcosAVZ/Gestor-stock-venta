/**
 * Tests unitarios para import handlers (T2 — RED).
 *
 * Verifica que los handlers del flujo de importación:
 * - handleImportarInit: inicia el estado IMPORTANDO_ESPERANDO_ARCHIVO
 * - handleDocumentoRecibido: parsea Excel, muestra diff, transiciona
 * - handleConfirmarImport: aplica cambios desde diff guardado
 * - handleCancelarImport: cancela importación
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConversationState } from '@compras-whatsapp/db';

import {
  handleImportarInit,
  handleDocumentoRecibido,
  handleConfirmarImport,
  handleCancelarImport,
} from '../../../src/application/handlers/importHandlers.ts';
import type { HandlerContext } from '../../../src/application/handlers/HandlerContext.ts';
import type { ImportDiff } from '../../../src/application/excel/ImportService.ts';

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
    exportService: {} as any,
    importService: {
      parse: vi.fn(),
      applyChanges: vi.fn(),
    } as any,
    chatId: '5491112345678@c.us',
    ...overrides,
  };
}

// ── handleImportarInit ──────────────────────────────────────────────

describe('handleImportarInit', () => {
  it('sets state to IMPORTANDO_ESPERANDO_ARCHIVO and asks for file', async () => {
    const ctx = buildMockCtx();
    const result = await handleImportarInit(ctx);

    expect(result.newState).toBe(ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO);
    expect(result.rejected).toBe(false);
    expect(result.responses[0]).toMatch(/archivo/i);
  });

  it('persists new state via conversacionRepo.update', async () => {
    const ctx = buildMockCtx();
    await handleImportarInit(ctx);

    expect(ctx.conversacionRepo.update).toHaveBeenCalledWith('user-1', {
      estado: ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO,
      datosTemporales: {},
    });
  });
});

// ── handleDocumentoRecibido ─────────────────────────────────────────

describe('handleDocumentoRecibido', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses Excel and shows diff with products to create', async () => {
    const ctx = buildMockCtx({ workingDatos: {} });
    ctx.importService.parse.mockResolvedValue({
      diff: {
        toCreate: [{ nombre: 'medias', stock: 100, precioVenta: 1500 }],
        toUpdatePrecio: [],
        toUpdateStock: [],
      },
      invalidRows: [],
    });

    const buffer = Buffer.from('fake-excel');
    const result = await handleDocumentoRecibido(ctx, buffer);

    expect(ctx.importService.parse).toHaveBeenCalledWith(buffer, 'user-1');
    expect(result.newState).toBe(ConversationState.IMPORTANDO_REVISANDO);
    expect(result.responses[0]).toContain('medias');
    expect(result.responses[0]).toContain('1500');
    expect(result.responses[0]).toContain('sí');
    expect(result.responses[0]).toContain('no');
    expect(result.rejected).toBe(false);
  });

  it('shows diff with precio changes', async () => {
    const ctx = buildMockCtx();
    ctx.importService.parse.mockResolvedValue({
      diff: {
        toCreate: [],
        toUpdatePrecio: [{ nombre: 'medias', stock: 100, precioVenta: 2000, oldPrecio: 1500 }],
        toUpdateStock: [],
      },
      invalidRows: [],
    });

    const result = await handleDocumentoRecibido(ctx, Buffer.from('x'));
    expect(result.responses[0]).toContain('medias');
    expect(result.responses[0]).toContain('$1500');
    expect(result.responses[0]).toContain('$2000');
  });

  it('shows diff with stock increases', async () => {
    const ctx = buildMockCtx();
    ctx.importService.parse.mockResolvedValue({
      diff: {
        toCreate: [],
        toUpdatePrecio: [],
        toUpdateStock: [{ nombre: 'remeras', stock: 150, oldStock: 100, precioVenta: 2500 }],
      },
      invalidRows: [],
    });

    const result = await handleDocumentoRecibido(ctx, Buffer.from('x'));
    expect(result.responses[0]).toContain('remeras');
    expect(result.responses[0]).toContain('+50');
  });

  it('handles mixed valid and invalid rows', async () => {
    const ctx = buildMockCtx();
    ctx.importService.parse.mockResolvedValue({
      diff: {
        toCreate: [{ nombre: 'medias', stock: 100, precioVenta: 1500 }],
        toUpdatePrecio: [],
        toUpdateStock: [],
      },
      invalidRows: [{ row: 3, errors: ['nombre vacío'] }],
    });

    const result = await handleDocumentoRecibido(ctx, Buffer.from('x'));
    expect(result.responses[0]).toContain('medias');
    expect(result.responses[0]).toContain('1 fila(s) inválida(s)');
  });

  it('returns error when all rows are invalid', async () => {
    const ctx = buildMockCtx();
    ctx.importService.parse.mockResolvedValue({
      diff: { toCreate: [], toUpdatePrecio: [], toUpdateStock: [] },
      invalidRows: [{ row: 2, errors: ['nombre vacío'] }],
    });

    const result = await handleDocumentoRecibido(ctx, Buffer.from('x'));
    expect(result.responses[0]).toMatch(/Ninguna fila válida/i);
    expect(result.newState).toBe(ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO);
  });

  it('truncates diff message to under 4000 chars', async () => {
    const ctx = buildMockCtx();
    // Create 50 products to generate a long diff
    const toCreate = Array.from({ length: 50 }, (_, i) => ({
      nombre: `producto-largo-${i}-con-nombre-extendido-para-test`,
      stock: 100 + i,
      precioVenta: 1500 + i,
    }));
    ctx.importService.parse.mockResolvedValue({
      diff: { toCreate, toUpdatePrecio: [], toUpdateStock: [] },
      invalidRows: [],
    });

    const result = await handleDocumentoRecibido(ctx, Buffer.from('x'));
    for (const response of result.responses) {
      expect(response.length).toBeLessThanOrEqual(4000);
    }
  });

  it('stores diff in datosTemporales for later confirm', async () => {
    const ctx = buildMockCtx();
    const mockDiff: ImportDiff = {
      toCreate: [{ nombre: 'medias', stock: 100, precioVenta: 1500 }],
      toUpdatePrecio: [],
      toUpdateStock: [],
    };
    ctx.importService.parse.mockResolvedValue({
      diff: mockDiff,
      invalidRows: [],
    });

    await handleDocumentoRecibido(ctx, Buffer.from('x'));
    expect(ctx.conversacionRepo.update).toHaveBeenCalledWith('user-1', {
      estado: ConversationState.IMPORTANDO_REVISANDO,
      datosTemporales: { importDiff: mockDiff },
    });
  });
});

// ── handleConfirmarImport ──────────────────────────────────────────

describe('handleConfirmarImport', () => {
  it('applies changes from stored diff and returns success', async () => {
    const mockDiff: ImportDiff = {
      toCreate: [{ nombre: 'medias', stock: 100, precioVenta: 1500 }],
      toUpdatePrecio: [],
      toUpdateStock: [],
    };
    const ctx = buildMockCtx({
      workingDatos: { importDiff: mockDiff },
    });

    const result = await handleConfirmarImport(ctx);

    expect(ctx.importService.applyChanges).toHaveBeenCalledWith('user-1', mockDiff);
    expect(result.responses[0]).toMatch(/aplicados/i);
    expect(result.newState).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
    expect(result.rejected).toBe(false);
  });

  it('returns error when no diff stored', async () => {
    const ctx = buildMockCtx({ workingDatos: {} });

    const result = await handleConfirmarImport(ctx);

    expect(ctx.importService.applyChanges).not.toHaveBeenCalled();
    expect(result.responses[0]).toMatch(/no hay datos/i);
  });
});

// ── handleCancelarImport ───────────────────────────────────────────

describe('handleCancelarImport', () => {
  it('returns cancelled message and resets to PREGUNTANDO_PRODUCTO', async () => {
    const ctx = buildMockCtx();
    const result = await handleCancelarImport(ctx);

    expect(result.responses[0]).toMatch(/cancelada/i);
    expect(result.newState).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
    expect(result.rejected).toBe(false);
  });
});
