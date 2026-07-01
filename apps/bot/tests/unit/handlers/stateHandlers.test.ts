/**
 * Tests unitarios para stateHandlers (special-case transitions — TDD RED→GREEN→REFACTOR).
 *
 * Verifica que handleSpecialCase maneja correctamente:
 * - AGREGANDO_STOCK + SELECCIONAR_PRODUCTO (modos agregar/editar/eliminar)
 * - EDITANDO_SELECCION + SELECCIONAR_CAMPO
 * - EDITANDO_VALOR + VALOR_EDITADO
 * - ELIMINANDO_PRODUCTOS (confirm/reject)
 */
import { describe, expect, it, vi } from 'vitest';
import { ConversationState } from '@compras-whatsapp/db';
import { Decimal } from 'decimal.js';

import { handleSpecialCase } from '../../../src/application/handlers/stateHandlers.ts';
import type { HandlerContext } from '../../../src/application/handlers/HandlerContext.ts';

// ── Mock factory ────────────────────────────────────────────────────

function buildMockCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    usuarioId: 'user-1',
    workingState: ConversationState.AGREGANDO_STOCK,
    workingDatos: {},
    conversacionRepo: {
      findByUsuarioId: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    } as any,
    compraRepo: {} as any,
    itemCompraRepo: {
      findByNombre: vi.fn(),
      updateById: vi.fn(),
      deleteByNombreAndUsuarioId: vi.fn(),
    } as any,
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

// ── Tests ───────────────────────────────────────────────────────────

describe('stateHandlers — handleSpecialCase', () => {
  describe('AGREGANDO_STOCK + eliminar mode', () => {
    it('shows deletion confirmation when modo is "eliminar"', async () => {
      const ctx = buildMockCtx({
        workingDatos: {
          modo: 'eliminar',
          productosDisponibles: [{ indice: 1, nombre: 'medias' }],
        },
      });
      const result = await handleSpecialCase({
        workingState: ConversationState.AGREGANDO_STOCK,
        event: { type: 'SELECCIONAR_PRODUCTO', indice: 1 },
        workingDatos: ctx.workingDatos,
        ctx,
      });
      expect(result).not.toBeNull();
      expect(result!.responses[0]).toContain('eliminar');
      expect(result!.responses[0]).toContain('medias');
      expect(result!.newState).toBe(ConversationState.ELIMINANDO_PRODUCTOS);
    });
  });

  describe('AGREGANDO_STOCK + editar mode', () => {
    it('shows edit field menu when modo is "editar"', async () => {
      const ctx = buildMockCtx({
        workingDatos: {
          modo: 'editar',
          productosDisponibles: [{ indice: 1, nombre: 'medias' }],
        },
      });
      const result = await handleSpecialCase({
        workingState: ConversationState.AGREGANDO_STOCK,
        event: { type: 'SELECCIONAR_PRODUCTO', indice: 1 },
        workingDatos: ctx.workingDatos,
        ctx,
      });
      expect(result).not.toBeNull();
      expect(result!.responses[0]).toContain('Editando');
      expect(result!.responses[0]).toContain('Nombre');
      expect(result!.newState).toBe(ConversationState.EDITANDO_SELECCION);
    });
  });

  describe('AGREGANDO_STOCK + agregar mode', () => {
    it('returns null (falls through to state machine)', async () => {
      const ctx = buildMockCtx({
        workingDatos: {
          modo: 'agregar',
          productosDisponibles: [{ indice: 1, nombre: 'medias' }],
        },
      });
      const result = await handleSpecialCase({
        workingState: ConversationState.AGREGANDO_STOCK,
        event: { type: 'SELECCIONAR_PRODUCTO', indice: 1 },
        workingDatos: ctx.workingDatos,
        ctx,
      });
      expect(result).toBeNull();
    });
  });

  describe('EDITANDO_SELECCION + campo selection', () => {
    it('valid campo (1-5) shows prompt and transitions to EDITANDO_VALOR', async () => {
      const ctx = buildMockCtx({
        workingDatos: { productoNombre: 'medias' },
      });
      const result = await handleSpecialCase({
        workingState: ConversationState.EDITANDO_SELECCION,
        event: { type: 'SELECCIONAR_CAMPO', campo: '1' },
        workingDatos: ctx.workingDatos,
        ctx,
      });
      expect(result).not.toBeNull();
      expect(result!.responses[0]).toContain('nuevo nombre');
      expect(result!.newState).toBe(ConversationState.EDITANDO_VALOR);
    });

    it('invalid campo returns rejected', async () => {
      const ctx = buildMockCtx({
        workingDatos: { productoNombre: 'medias' },
      });
      const result = await handleSpecialCase({
        workingState: ConversationState.EDITANDO_SELECCION,
        event: { type: 'SELECCIONAR_CAMPO', campo: '6' },
        workingDatos: ctx.workingDatos,
        ctx,
      });
      expect(result).not.toBeNull();
      expect(result!.rejected).toBe(true);
      expect(result!.responses[0]).toContain('no válida');
    });
  });

  describe('EDITANDO_VALOR + value update', () => {
    it('updates nombre field successfully', async () => {
      const ctx = buildMockCtx();
      ctx.itemCompraRepo.findByNombre.mockResolvedValue([{
        id: 'item-1',
        nombre: 'medias',
        costoLote: new Decimal('1200'),
        costoUnitario: new Decimal('100'),
        precioVenta: new Decimal('1500'),
        cantidadLote: 12,
        unidad: 'PAR',
      }]);
      const result = await handleSpecialCase({
        workingState: ConversationState.EDITANDO_VALOR,
        event: { type: 'VALOR_EDITADO', valor: 'nuevas medias' },
        workingDatos: {
          campoEditando: '1',
          productoIndice: 1,
          productoNombre: 'medias',
          productosDisponibles: [{ indice: 1, nombre: 'medias' }],
        },
        ctx,
      });
      expect(result).not.toBeNull();
      expect(result!.responses[0]).toContain('nombre');
      expect(result!.newState).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
    });

    it('validates cantidad > 0', async () => {
      const ctx = buildMockCtx();
      ctx.itemCompraRepo.findByNombre.mockResolvedValue([{
        id: 'item-1',
        nombre: 'medias',
        costoLote: new Decimal('1200'),
        costoUnitario: new Decimal('100'),
        precioVenta: new Decimal('1500'),
        cantidadLote: 12,
        unidad: 'PAR',
      }]);
      const result = await handleSpecialCase({
        workingState: ConversationState.EDITANDO_VALOR,
        event: { type: 'VALOR_EDITADO', valor: 0 },
        workingDatos: {
          campoEditando: '2',
          productoIndice: 1,
          productoNombre: 'medias',
          productosDisponibles: [{ indice: 1, nombre: 'medias' }],
        },
        ctx,
      });
      expect(result).not.toBeNull();
      expect(result!.rejected).toBe(true);
      expect(result!.responses[0]).toContain('mayor a cero');
    });
  });

  describe('ELIMINANDO_PRODUCTOS', () => {
    it('USUARIO_CONFIRMA deletes product', async () => {
      const ctx = buildMockCtx();
      ctx.itemCompraRepo.deleteByNombreAndUsuarioId.mockResolvedValue(3);
      const result = await handleSpecialCase({
        workingState: ConversationState.ELIMINANDO_PRODUCTOS,
        event: { type: 'USUARIO_CONFIRMA' },
        workingDatos: { productoNombre: 'medias' },
        ctx,
      });
      expect(result).not.toBeNull();
      expect(result!.responses[0]).toContain('eliminé');
      expect(result!.responses[0]).toContain('3 registros');
      expect(result!.newState).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
    });

    it('USUARIO_RECHAZA cancels deletion', async () => {
      const ctx = buildMockCtx();
      const result = await handleSpecialCase({
        workingState: ConversationState.ELIMINANDO_PRODUCTOS,
        event: { type: 'USUARIO_RECHAZA' },
        workingDatos: { productoNombre: 'medias' },
        ctx,
      });
      expect(result).not.toBeNull();
      expect(result!.responses[0]).toContain('no borro nada');
      expect(result!.newState).toBe(ConversationState.PREGUNTANDO_PRODUCTO);
    });

    it('other event returns prompt to respond sí/no', async () => {
      const ctx = buildMockCtx();
      const result = await handleSpecialCase({
        workingState: ConversationState.ELIMINANDO_PRODUCTOS,
        event: { type: 'PRODUCTO_RECIBIDO', valor: 'test' },
        workingDatos: { productoNombre: 'medias' },
        ctx,
      });
      expect(result).not.toBeNull();
      expect(result!.rejected).toBe(true);
      expect(result!.responses[0]).toContain('sí');
      expect(result!.newState).toBe(ConversationState.ELIMINANDO_PRODUCTOS);
    });
  });

  describe('non-matching state/event', () => {
    it('returns null for states without special handling', async () => {
      const ctx = buildMockCtx();
      const result = await handleSpecialCase({
        workingState: ConversationState.PREGUNTANDO_PRODUCTO,
        event: { type: 'PRODUCTO_RECIBIDO', valor: 'test' },
        workingDatos: {},
        ctx,
      });
      expect(result).toBeNull();
    });
  });
});
