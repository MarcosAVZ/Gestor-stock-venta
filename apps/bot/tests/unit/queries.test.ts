/**
 * Tests unitarios para los 5 query use cases consolidados (mejora-visual-estadisticas).
 *
 * Cobertura:
 * - parseQueryCommand: 17 aliases resuelven a 5 tipos nuevos, unknown → null.
 * - getEstadisticas: vacío, datos completos, sin ventas, sin compras del mes.
 * - getProductos: vacío, con stock, todo vendido.
 * - getProductoByName: exacto, fuzzy, sin match, vacío.
 * - getComprasMes: vacío, con compras.
 * - getTopGanancias: vacío, con items.
 * - executeQuery dispatch: 5 tipos nuevos.
 * - HELP_TEXT y UNKNOWN_COMMAND_MESSAGE: solo 5 comandos nuevos.
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';

import { Unidad } from '@compras-whatsapp/db';

import {
  executeQuery,
  getComprasMes,
  getEstadisticas,
  getGrupoStats,
  getProductoByName,
  getProductos,
  getTopGanancias,
  parseQueryCommand,
  HELP_TEXT,
  UNKNOWN_COMMAND_MESSAGE,
} from '../../src/application/queries/index.ts';

// ── Helpers ───────────────────────────────────────────────────────────

function buildMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function buildMockPrisma(overrides: {
  compras?: Array<{
    id?: string;
    fecha?: Date;
    items: Array<{
      nombre: string;
      cantidadLote: number;
      unidad: string;
      costoLote: Decimal | string;
      gananciaTotal: Decimal | string;
      gananciaUnitaria?: Decimal | string;
      precioVenta?: Decimal | string;
      costoUnitario?: Decimal | string;
      updatedAt?: Date;
    }>;
  }>;
  items?: Array<{
    id?: string;
    nombre: string;
    cantidadLote?: number;
    unidad?: string;
    gananciaUnitaria: Decimal | string;
    updatedAt?: Date;
    costoLote?: Decimal | string;
    precioVenta?: Decimal | string;
    costoUnitario?: Decimal | string;
  }>;
  fuzzy?: Array<{
    id?: string;
    compraId?: string;
    nombre: string;
    cantidadLote: number;
    unidad: string;
    costoLote: Decimal;
    gananciaTotal: Decimal;
    gananciaUnitaria: Decimal;
    precioVenta: Decimal;
    costoUnitario: Decimal;
    updatedAt: Date;
  }>;
  ventas?: Array<{
    usuarioId: string;
    productoNombre: string;
    cantidad: number;
    precioVenta: Decimal | string;
    costoUnitario: Decimal | string;
    gananciaUnitaria: Decimal | string;
    gananciaTotal: Decimal | string;
    fecha?: Date;
  }>;
} = {}) {
  return {
    compra: {
      findMany: vi.fn(async () => overrides.compras ?? []),
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    itemCompra: {
      findMany: vi.fn(async (_args: { select?: { nombre?: boolean } }) => {
        // getProductoByName para match exacto pasa sin select.nombre
        return overrides.items ?? [];
      }),
      createMany: vi.fn(),
      findFirst: vi.fn(),
    },
    venta: {
      findMany: vi.fn(async () => overrides.ventas ?? []),
      aggregate: vi.fn(async () => ({ _sum: { gananciaTotal: null } })),
      count: vi.fn(async () => 0),
      create: vi.fn(),
    },
    $queryRaw: vi.fn(async () => overrides.fuzzy ?? []),
    usuario: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    conversacion: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    grupoProducto: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  };
}

const emptyDeps = () => ({ prisma: buildMockPrisma() as never, logger: buildMockLogger() as never });

// ── Tests ─────────────────────────────────────────────────────────────

describe('queries', () => {
  describe('parseQueryCommand', () => {
    it.each([
      ['resumen', { type: 'estadisticas' }],
      ['  RESUMEN  ', { type: 'estadisticas' }],
      ['ganancias', { type: 'estadisticas' }],
      ['ingresos', { type: 'estadisticas' }],
      ['ganancia realizada', { type: 'estadisticas' }],
      ['ganancia potencial', { type: 'estadisticas' }],
      ['costo promedio', { type: 'estadisticas' }],
      ['estadisticas', { type: 'estadisticas' }],
      ['estadísticas', { type: 'estadisticas' }],
      ['productos', { type: 'productos' }],
      ['stock', { type: 'productos' }],
      ['compras mes', { type: 'compras' }],
      ['compras-mes', { type: 'compras' }],
      ['compras del mes', { type: 'compras' }],
      ['compras', { type: 'compras' }],
      ['top ganancias', { type: 'top' }],
      ['top', { type: 'top' }],
      ['producto medias negras', { type: 'producto', nombre: 'medias negras' }],
    ])('parsea "%s" → %j', (input, expected) => {
      expect(parseQueryCommand(input)).toEqual(expected);
    });

    it.each([
      ['grupo Medias', { type: 'grupo', nombre: 'medias' }],
      ['grupo Lácteos', { type: 'grupo', nombre: 'lácteos' }],
      ['  grupo  Medias  ', { type: 'grupo', nombre: 'medias' }],
    ])('parsea "%s" → %j', (input, expected) => {
      expect(parseQueryCommand(input)).toEqual(expected);
    });

    it.each(['hola', 'qué hacés', 'producto', '  '])('input "%s" → null', (input) => {
      expect(parseQueryCommand(input)).toBeNull();
    });

    it('input "grupo" → { type: grupo }', () => {
      expect(parseQueryCommand('grupo')).toEqual({ type: 'grupo' });
    });

    it('input "grupo " → { type: grupo }', () => {
      expect(parseQueryCommand('grupo ')).toEqual({ type: 'grupo' });
    });
  });

  describe('getEstadisticas', () => {
    it('DB vacía: mensaje estándar', async () => {
      const r = await getEstadisticas('user-1', emptyDeps());
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('datos completos con ventas: 3 secciones con valores correctos', async () => {
      const now = new Date();
      const past = new Date(now);
      past.setDate(past.getDate() - 40); // mes anterior o más

      const deps = {
        prisma: buildMockPrisma({
          compras: [
            {
              id: 'c1',
              fecha: now,
              items: [
                { nombre: 'a', cantidadLote: 10, unidad: 'UNIDAD', costoLote: new Decimal(1000), gananciaTotal: new Decimal(1500), precioVenta: new Decimal(200), costoUnitario: new Decimal(100), updatedAt: now },
              ],
            },
            {
              id: 'c2',
              fecha: now,
              items: [
                { nombre: 'b', cantidadLote: 5, unidad: 'UNIDAD', costoLote: new Decimal(500), gananciaTotal: new Decimal(800), precioVenta: new Decimal(150), costoUnitario: new Decimal(100), updatedAt: now },
              ],
            },
            {
              id: 'c3',
              fecha: past,
              items: [
                { nombre: 'c', cantidadLote: 3, unidad: 'UNIDAD', costoLote: new Decimal(300), gananciaTotal: new Decimal(400), precioVenta: new Decimal(100), costoUnitario: new Decimal(100), updatedAt: past },
              ],
            },
          ],
          ventas: [
            { usuarioId: 'user-1', productoNombre: 'a', cantidad: 3, precioVenta: new Decimal(200), costoUnitario: new Decimal(100), gananciaUnitaria: new Decimal(100), gananciaTotal: new Decimal(600) },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getEstadisticas('user-1', deps);
      // Monthly: 2 compras, invertido 1500, ganancia 2300
      expect(r).toContain('📦 2 compras');
      expect(r).toContain('💸 Invertido: $1.500');
      expect(r).toContain('📈 Ganancia potencial: $2.300');
      // Totals: 3 compras, 3 items, ticket 600
      expect(r).toContain('🛒 3 compras · 3 items');
      expect(r).toContain('🎫 Ticket promedio: $600');
      // Ventas: ingresos 600, ganancia realizada 600
      expect(r).toContain('💰 Ingresos: $600');
      expect(r).toContain('✅ Ganancia realizada: $600');
      expect(r).toContain('📊 Ganancia potencial restante: $950');
      expect(r).toContain('💵 Costo promedio: $100');
    });

    it('compras sin ventas: omite sección Ventas', async () => {
      const now = new Date();
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            {
              id: 'c1',
              fecha: now,
              items: [
                { nombre: 'a', cantidadLote: 10, unidad: 'UNIDAD', costoLote: new Decimal(1000), gananciaTotal: new Decimal(1500), precioVenta: new Decimal(200), costoUnitario: new Decimal(100), updatedAt: now },
              ],
            },
          ],
          ventas: [],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getEstadisticas('user-1', deps);
      expect(r).toContain('📦 1 compra');
      expect(r).not.toContain('▫️ *Ventas*');
    });

    it('compras pasadas sin compras del mes: sección mensual con 0s', async () => {
      const past = new Date();
      past.setDate(past.getDate() - 40);

      const deps = {
        prisma: buildMockPrisma({
          compras: [
            {
              id: 'c1',
              fecha: past,
              items: [
                { nombre: 'a', cantidadLote: 10, unidad: 'UNIDAD', costoLote: new Decimal(1000), gananciaTotal: new Decimal(1500), precioVenta: new Decimal(200), costoUnitario: new Decimal(100), updatedAt: past },
              ],
            },
          ],
          ventas: [],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getEstadisticas('user-1', deps);
      expect(r).toContain('📦 0 compras');
      expect(r).toContain('💸 Invertido: $0');
      expect(r).toContain('📈 Ganancia potencial: $0');
      expect(r).toContain('🛒 1 compra · 1 item');
    });
  });

  describe('getProductos', () => {
    it('DB vacía: mensaje estándar', async () => {
      const r = await getProductos('user-1', emptyDeps());
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('productos con stock: lista formateada con stock info', async () => {
      const now = new Date();
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            {
              id: 'c1',
              fecha: now,
              items: [
                { nombre: 'medias', cantidadLote: 20, unidad: 'PAR', costoLote: new Decimal(2000), gananciaTotal: new Decimal(0), precioVenta: new Decimal(250), costoUnitario: new Decimal(100), updatedAt: now },
                { nombre: 'cajas', cantidadLote: 5, unidad: 'CAJA', costoLote: new Decimal(2500), gananciaTotal: new Decimal(0), precioVenta: new Decimal(500), costoUnitario: new Decimal(500), updatedAt: now },
              ],
            },
          ],
          ventas: [],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getProductos('user-1', deps);
      expect(r).toBe('📦 *PRODUCTOS*\n\n• cajas — 5 en stock\n• medias — 20 en stock');
    });

    it('todos sin stock: mensaje estándar', async () => {
      const now = new Date();
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            {
              id: 'c1',
              fecha: now,
              items: [
                { nombre: 'medias', cantidadLote: 10, unidad: 'PAR', costoLote: new Decimal(1000), gananciaTotal: new Decimal(0), precioVenta: new Decimal(200), costoUnitario: new Decimal(100), updatedAt: now },
              ],
            },
          ],
          ventas: [
            { usuarioId: 'user-1', productoNombre: 'medias', cantidad: 10, precioVenta: new Decimal(200), costoUnitario: new Decimal(100), gananciaUnitaria: new Decimal(100), gananciaTotal: new Decimal(1000) },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getProductos('user-1', deps);
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });
  });

  describe('getProductoByName', () => {
    it('match exacto: nuevo formato detalle', async () => {
      const deps = {
        prisma: {
          ...buildMockPrisma({ compras: [], items: [], fuzzy: [] }),
          itemCompra: {
            findMany: vi.fn(async () => [
              {
                id: 'i1',
                compraId: 'c1',
                nombre: 'medias negras',
                cantidadLote: 12,
                unidad: Unidad.PAR,
                costoLote: new Decimal(1200),
                costoUnitario: new Decimal(100),
                precioVenta: new Decimal(1500),
                gananciaUnitaria: new Decimal(1400),
                gananciaTotal: new Decimal(16800),
                updatedAt: new Date(),
              },
            ]),
            createMany: vi.fn(),
            findFirst: vi.fn(),
          },
        } as never,
        logger: buildMockLogger() as never,
      };
      const r = await getProductoByName('user-1', 'medias negras', deps);
      expect(r).toBe('🔍 *medias negras*\n   Stock: 12 par\n   Costo: $100 c/u\n   Venta: $1.500 c/u\n   Ganancia: $1.400 c/u');
    });

    it('sin match exacto: fallback fuzzy con pg_trgm', async () => {
      const prisma = buildMockPrisma({
        compras: [],
        items: [],
        fuzzy: [{
          id: 'i1',
          compraId: 'c1',
          nombre: 'medias negras',
          cantidadLote: 12,
          unidad: Unidad.PAR,
          costoLote: new Decimal(1200),
          costoUnitario: new Decimal(100),
          precioVenta: new Decimal(1500),
          gananciaUnitaria: new Decimal(1400),
          gananciaTotal: new Decimal(16800),
          updatedAt: new Date(),
        }],
      });
      prisma.itemCompra.findMany = vi.fn(async () => []);
      const r = await getProductoByName('user-1', 'medias', { prisma: prisma as never, logger: buildMockLogger() as never });
      expect(r).toBe('🔍 *medias negras*\n   Stock: 12 par\n   Costo: $100 c/u\n   Venta: $1.500 c/u\n   Ganancia: $1.400 c/u');
    });

    it('sin match: mensaje "No encontré"', async () => {
      const r = await getProductoByName('user-1', 'zapallos', emptyDeps());
      expect(r).toContain('No encontré');
      expect(r).toContain('zapallos');
    });

    it('input vacío: pide nombre', async () => {
      const r = await getProductoByName('user-1', '', emptyDeps());
      expect(r).toContain('Decime el nombre del producto');
    });
  });

  describe('getComprasMes', () => {
    it('sin compras este mes: mensaje', async () => {
      const r = await getComprasMes('user-1', emptyDeps());
      expect(r).toBe('No tenés compras cargadas este mes.');
    });

    it('con compras: nuevo formato con emoji', async () => {
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            { id: 'c1', fecha: new Date(2026, 5, 15), items: [{ nombre: 'a', cantidadLote: 1, unidad: 'UNIDAD', costoLote: new Decimal(1000), gananciaTotal: new Decimal(0) }] },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getComprasMes('user-1', deps);
      expect(r).toBe('🛒 *COMPRAS DEL MES* (1)\n\n• 15/6 — $1.000');
    });
  });

  describe('getTopGanancias', () => {
    it('DB vacía: mensaje estándar', async () => {
      const r = await getTopGanancias(5, emptyDeps());
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('lista top N con nuevo formato', async () => {
      const deps = {
        prisma: buildMockPrisma({
          items: [
            { nombre: 'a', gananciaUnitaria: new Decimal(5000) },
            { nombre: 'b', gananciaUnitaria: new Decimal(3000) },
            { nombre: 'c', gananciaUnitaria: new Decimal(1000) },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getTopGanancias(3, deps);
      expect(r).toBe('🏆 *TOP GANANCIAS*\n\n1. a — $5.000 c/u\n2. b — $3.000 c/u\n3. c — $1.000 c/u');
    });
  });

  describe('getGrupoStats', () => {
    it('grupo exists with user products: returns formatted stats', async () => {
      const now = new Date();
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            {
              id: 'c1',
              fecha: now,
              items: [
                { nombre: 'medias de bolitas', cantidadLote: 20, unidad: 'UNIDAD', costoLote: new Decimal(2000), gananciaTotal: new Decimal(0), precioVenta: new Decimal(250), costoUnitario: new Decimal(100), updatedAt: now },
                { nombre: 'medias negras', cantidadLote: 10, unidad: 'UNIDAD', costoLote: new Decimal(1500), gananciaTotal: new Decimal(0), precioVenta: new Decimal(300), costoUnitario: new Decimal(150), updatedAt: now },
              ],
            },
          ],
          ventas: [],
        }) as never,
        logger: buildMockLogger() as never,
      };
      // Override grupoProducto.findMany
      (deps.prisma as any).grupoProducto = {
        findMany: vi.fn(async () => [
          { productoNombre: 'medias de bolitas', grupoNombre: 'medias', createdAt: now, updatedAt: now },
          { productoNombre: 'medias negras', grupoNombre: 'medias', createdAt: now, updatedAt: now },
        ]),
        findUnique: vi.fn(),
        upsert: vi.fn(),
      };
      const r = await getGrupoStats('user-1', 'medias', deps);
      expect(r).toContain('📁');
      expect(r).toContain('GRUPO');
      expect(r).toContain('medias de bolitas');
      expect(r).toContain('medias negras');
    });

    it('grupo exists but no user products: returns message', async () => {
      const now = new Date();
      const deps = {
        prisma: buildMockPrisma({ compras: [], ventas: [] }) as never,
        logger: buildMockLogger() as never,
      };
      (deps.prisma as any).grupoProducto = {
        findMany: vi.fn(async () => [
          { productoNombre: 'ajenjo', grupoNombre: 'hierbas', createdAt: now, updatedAt: now },
        ]),
        findUnique: vi.fn(),
        upsert: vi.fn(),
      };
      const r = await getGrupoStats('user-1', 'hierbas', deps);
      expect(r).toContain('no tenés productos');
    });

    it('grupo not found: returns "No encontré"', async () => {
      const deps = emptyDeps();
      (deps.prisma as any).grupoProducto = {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(),
        upsert: vi.fn(),
      };
      const r = await getGrupoStats('user-1', 'noexiste', deps);
      expect(r).toContain('No encontré');
      expect(r).toContain('noexiste');
    });
  });

  describe('getEstadisticas — con grupos', () => {
    it('with grupos and compras: includes "Por grupo" section', async () => {
      const now = new Date();
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            {
              id: 'c1',
              fecha: now,
              items: [
                { nombre: 'medias de bolitas', cantidadLote: 20, unidad: 'UNIDAD', costoLote: new Decimal(2000), gananciaTotal: new Decimal(3000), precioVenta: new Decimal(250), costoUnitario: new Decimal(100), updatedAt: now },
              ],
            },
          ],
          ventas: [],
        }) as never,
        logger: buildMockLogger() as never,
      };
      (deps.prisma as any).grupoProducto = {
        findMany: vi.fn(async () => [
          { productoNombre: 'medias de bolitas', grupoNombre: 'medias', createdAt: now, updatedAt: now },
        ]),
        findUnique: vi.fn(),
        upsert: vi.fn(),
      };
      const r = await getEstadisticas('user-1', deps);
      expect(r).toContain('▫️ *Por grupo*');
      expect(r).toContain('medias');
    });

    it('without grupos: omits "Por grupo" section', async () => {
      const now = new Date();
      const deps = {
        prisma: buildMockPrisma({
          compras: [{
            id: 'c1', fecha: now,
            items: [{ nombre: 'a', cantidadLote: 10, unidad: 'UNIDAD', costoLote: new Decimal(1000), gananciaTotal: new Decimal(1500), precioVenta: new Decimal(200), costoUnitario: new Decimal(100), updatedAt: now }],
          }],
          ventas: [],
        }) as never,
        logger: buildMockLogger() as never,
      };
      (deps.prisma as any).grupoProducto = {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(),
        upsert: vi.fn(),
      };
      const r = await getEstadisticas('user-1', deps);
      expect(r).not.toContain('▫️ *Por grupo*');
    });
  });

  describe('getProductos — con grupos', () => {
    it('with grupos: groups products by grupoNombre', async () => {
      const now = new Date();
      const deps = {
        prisma: buildMockPrisma({
          compras: [{
            id: 'c1', fecha: now,
            items: [
              { nombre: 'agua mineral', cantidadLote: 10, unidad: 'UNIDAD', costoLote: new Decimal(500), gananciaTotal: new Decimal(0), precioVenta: new Decimal(100), costoUnitario: new Decimal(50), updatedAt: now },
              { nombre: 'leche entera', cantidadLote: 8, unidad: 'UNIDAD', costoLote: new Decimal(800), gananciaTotal: new Decimal(0), precioVenta: new Decimal(150), costoUnitario: new Decimal(100), updatedAt: now },
              { nombre: 'arroz', cantidadLote: 20, unidad: 'UNIDAD', costoLote: new Decimal(1000), gananciaTotal: new Decimal(0), precioVenta: new Decimal(80), costoUnitario: new Decimal(50), updatedAt: now },
            ],
          }],
          ventas: [],
        }) as never,
        logger: buildMockLogger() as never,
      };
      (deps.prisma as any).grupoProducto = {
        findMany: vi.fn(async () => [
          { productoNombre: 'agua mineral', grupoNombre: 'bebidas', createdAt: now, updatedAt: now },
          { productoNombre: 'leche entera', grupoNombre: 'lácteos', createdAt: now, updatedAt: now },
        ]),
        findUnique: vi.fn(),
        upsert: vi.fn(),
      };
      const r = await getProductos('user-1', deps);
      // Group headers should appear
      expect(r).toContain('📁');
      expect(r).toContain('bebidas');
      expect(r).toContain('lácteos');
      // Unmapped product under SIN GRUPO
      expect(r).toContain('SIN GRUPO');
      expect(r).toContain('arroz');
    });

    it('without grupos: flat list (backward compat)', async () => {
      const now = new Date();
      const deps = {
        prisma: buildMockPrisma({
          compras: [{
            id: 'c1', fecha: now,
            items: [
              { nombre: 'agua mineral', cantidadLote: 10, unidad: 'UNIDAD', costoLote: new Decimal(500), gananciaTotal: new Decimal(0), precioVenta: new Decimal(100), costoUnitario: new Decimal(50), updatedAt: now },
            ],
          }],
          ventas: [],
        }) as never,
        logger: buildMockLogger() as never,
      };
      (deps.prisma as any).grupoProducto = {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(),
        upsert: vi.fn(),
      };
      const r = await getProductos('user-1', deps);
      expect(r).toBe('📦 *PRODUCTOS*\n\n• agua mineral — 10 en stock');
    });
  });

  describe('executeQuery dispatch', () => {
    it('dispatchea estadisticas', async () => {
      const deps = emptyDeps();
      const cmd = parseQueryCommand('resumen');
      expect(cmd).toEqual({ type: 'estadisticas' });
      const r = await executeQuery(cmd!, 'user-1', deps);
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('dispatchea productos', async () => {
      const deps = emptyDeps();
      const cmd = parseQueryCommand('stock');
      expect(cmd).toEqual({ type: 'productos' });
      const r = await executeQuery(cmd!, 'user-1', deps);
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('dispatchea producto', async () => {
      const deps = emptyDeps();
      const cmd = parseQueryCommand('producto medias');
      expect(cmd).toEqual({ type: 'producto', nombre: 'medias' });
      const r = await executeQuery(cmd!, 'user-1', deps);
      expect(r).toContain('No encontré');
    });

    it('dispatchea compras', async () => {
      const deps = emptyDeps();
      const cmd = parseQueryCommand('compras mes');
      expect(cmd).toEqual({ type: 'compras' });
      const r = await executeQuery(cmd!, 'user-1', deps);
      expect(r).toBe('No tenés compras cargadas este mes.');
    });

    it('dispatchea top', async () => {
      const deps = emptyDeps();
      const cmd = parseQueryCommand('top');
      expect(cmd).toEqual({ type: 'top' });
      const r = await executeQuery(cmd!, 'user-1', deps);
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('dispatchea grupo query', async () => {
      const deps = emptyDeps();
      (deps.prisma as any).grupoProducto = {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(),
        upsert: vi.fn(),
      };
      const cmd = parseQueryCommand('grupo medias');
      expect(cmd).toEqual({ type: 'grupo', nombre: 'medias' });
      const r = await executeQuery(cmd!, 'user-1', deps);
      expect(r).toContain('No encontré');
    });
  });

  describe('HELP_TEXT', () => {
    it('incluye /exportar', () => {
      expect(HELP_TEXT).toContain('/exportar');
    });

    it('incluye /importar', () => {
      expect(HELP_TEXT).toContain('/importar');
    });
  });

  describe('UNKNOWN_COMMAND_MESSAGE', () => {
    it('referencia los comandos incluyendo grupo', () => {
      expect(UNKNOWN_COMMAND_MESSAGE).toContain('estadisticas');
      expect(UNKNOWN_COMMAND_MESSAGE).toContain('productos');
      expect(UNKNOWN_COMMAND_MESSAGE).toContain('compras');
      expect(UNKNOWN_COMMAND_MESSAGE).toContain('top');
      expect(UNKNOWN_COMMAND_MESSAGE).toContain('grupo');
      // Old commands should NOT appear
      expect(UNKNOWN_COMMAND_MESSAGE).not.toContain('resumen');
      expect(UNKNOWN_COMMAND_MESSAGE).not.toContain('ganancias');
      expect(UNKNOWN_COMMAND_MESSAGE).not.toContain('ingresos');
      expect(UNKNOWN_COMMAND_MESSAGE).not.toContain('costo promedio');
    });

    it('menciona exportar e importar', () => {
      expect(UNKNOWN_COMMAND_MESSAGE).toContain('/exportar');
      expect(UNKNOWN_COMMAND_MESSAGE).toContain('/importar');
    });
  });
});
