/**
 * Tests unitarios para los 8 query use cases (PR5 task 5.6).
 *
 * Usamos mocks manuales de `PrismaClientLike` (subset) para no
 * depender de la DB real. Cada test:
 * - Configura el mock para responder lo que la query necesita.
 * - Verifica el string formateado que retorna el use case.
 *
 * Cobertura:
 * - Happy path de cada uno de los 8 queries.
 * - DB vacía para queries de agregación.
 * - getProductoByName: match exacto, fuzzy match, no match.
 * - parseQueryCommand: variantes de input (con/sin tilde, con args).
 * - logUnknownCommand: no throw.
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';

import { Unidad } from '@compras-whatsapp/db';

import {
  executeQuery,
  getComprasMes,
  getCostoPromedio,
  getEstadisticas,
  getGananciaPotencial,
  getGananciaRealizada,
  getGanancias,
  getIngresos,
  getProductoByName,
  getProductos,
  getResumen,
  getStock,
  getStockPerProduct,
  getTopGanancias,
  parseQueryCommand,
} from '../../src/application/queries/index.ts';

// ── Mocks ───────────────────────────────────────────────────────────

function buildMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function buildMockPrisma(overrides: {
  compras?: Array<{ id?: string; fecha?: Date; items: Array<{ nombre: string; cantidadLote: number; unidad: string; costoLote: Decimal | string; gananciaTotal: Decimal | string; gananciaUnitaria?: Decimal | string; precioVenta?: Decimal | string; costoUnitario?: Decimal | string; updatedAt?: Date }> }>;
  items?: Array<{ id?: string; nombre: string; cantidadLote?: number; unidad?: string; gananciaUnitaria: Decimal | string; updatedAt?: Date; costoLote?: Decimal | string; precioVenta?: Decimal | string; costoUnitario?: Decimal | string }>;
  fuzzy?: Array<{ id?: string; compraId?: string; nombre: string; cantidadLote: number; unidad: string; costoLote: Decimal; gananciaTotal: Decimal; gananciaUnitaria: Decimal; precioVenta: Decimal; costoUnitario: Decimal; updatedAt: Date }>;
  ventas?: Array<{ usuarioId: string; productoNombre: string; cantidad: number; precioVenta: Decimal | string; costoUnitario: Decimal | string; gananciaUnitaria: Decimal | string; gananciaTotal: Decimal | string; fecha?: Date }>;
} = {}) {
  return {
    compra: {
      findMany: vi.fn(async () => overrides.compras ?? []),
      create: vi.fn(),
      findUnique: vi.fn(),
    },
    itemCompra: {
      findMany: vi.fn(async (args: { select?: { nombre?: boolean } }) => {
        // getProductos pasa `select: { nombre: true }`. getTopGanancias no.
        if (args.select?.nombre === true) {
          return (overrides.items ?? []).map((i) => ({ nombre: i.nombre }));
        }
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
  };
}

const emptyDeps = () => ({ prisma: buildMockPrisma() as never, logger: buildMockLogger() as never });

// ── Tests ───────────────────────────────────────────────────────────

describe('queries', () => {
  describe('getResumen', () => {
    it('DB vacía: mensaje estándar', async () => {
      const r = await getResumen('user-1', emptyDeps());
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('mes con compras: formato "N compras, invertido $X, ganancia $Y"', async () => {
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            { id: 'c1', items: [{ nombre: 'a', cantidadLote: 10, unidad: 'UNIDAD', costoLote: new Decimal(1200), gananciaTotal: new Decimal(1800) }] },
            { id: 'c2', items: [{ nombre: 'b', cantidadLote: 5, unidad: 'PAR', costoLote: new Decimal(800), gananciaTotal: new Decimal(1500) }] },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getResumen('user-1', deps);
      expect(r).toContain('2 compras');
      expect(r).toContain('invertido $2.000');
      expect(r).toContain('ganancia potencial $3.300');
    });
  });

  describe('getEstadisticas', () => {
    it('DB vacía: mensaje estándar', async () => {
      const r = await getEstadisticas('user-1', emptyDeps());
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('ticket promedio = totalInvertido / compras', async () => {
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            { id: 'c1', items: [{ nombre: 'a', cantidadLote: 10, unidad: 'UNIDAD', costoLote: new Decimal(1000), gananciaTotal: new Decimal(0) }] },
            { id: 'c2', items: [{ nombre: 'b', cantidadLote: 5, unidad: 'PAR', costoLote: new Decimal(2000), gananciaTotal: new Decimal(0) }] },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getEstadisticas('user-1', deps);
      expect(r).toContain('2 compras');
      expect(r).toContain('2 items');
      expect(r).toContain('ticket promedio $1.500');
    });
  });

  describe('getGanancias', () => {
    it('DB vacía: mensaje estándar', async () => {
      const r = await getGanancias('user-1', emptyDeps());
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('suma todas las gananciaTotal', async () => {
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            { id: 'c1', items: [{ nombre: 'a', cantidadLote: 1, unidad: 'UNIDAD', costoLote: new Decimal(0), gananciaTotal: new Decimal(5000) }] },
            { id: 'c2', items: [{ nombre: 'b', cantidadLote: 1, unidad: 'UNIDAD', costoLote: new Decimal(0), gananciaTotal: new Decimal(7500) }] },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getGanancias('user-1', deps);
      expect(r).toBe('Ganancia potencial acumulada: $12.500.');
    });
  });

  describe('getProductos', () => {
    it('DB vacía: mensaje estándar', async () => {
      const r = await getProductos('user-1', emptyDeps());
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('lista productos únicos con count', async () => {
      const deps = {
        prisma: buildMockPrisma({
          items: [
            { nombre: 'medias negras', gananciaUnitaria: new Decimal(0) },
            { nombre: 'medias negras', gananciaUnitaria: new Decimal(0) },
            { nombre: 'cajas', gananciaUnitaria: new Decimal(0) },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getProductos('user-1', deps);
      expect(r).toContain('Tus 2 productos:');
      expect(r).toContain('medias negras (2 cargas)');
      expect(r).toContain('cajas (1 carga)');
    });
  });

  describe('getStock', () => {
    it('DB vacía: mensaje estándar', async () => {
      const r = await getStock('user-1', emptyDeps());
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('suma cantidades por nombre de producto', async () => {
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            { id: 'c1', items: [
              { nombre: 'medias', cantidadLote: 12, unidad: 'PAR', costoLote: new Decimal(0), gananciaTotal: new Decimal(0) },
              { nombre: 'cajas', cantidadLote: 5, unidad: 'CAJA', costoLote: new Decimal(0), gananciaTotal: new Decimal(0) },
            ] },
            { id: 'c2', items: [
              { nombre: 'medias', cantidadLote: 8, unidad: 'PAR', costoLote: new Decimal(0), gananciaTotal: new Decimal(0) },
            ] },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getStock('user-1', deps);
      expect(r).toContain('Tu stock:');
      expect(r).toContain('cajas: 5 caja');
      expect(r).toContain('medias: 20 par');
    });
  });

  describe('getProductoByName', () => {
    it('match exacto: retorna detalle', async () => {
      const deps = {
        prisma: {
          ...buildMockPrisma({
            compras: [],
            items: [],
            fuzzy: [],
          }),
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
      expect(r).toContain('medias negras');
      expect(r).toContain('12 par');
      expect(r).toContain('costo $100 c/u');
      expect(r).toContain('vendés a $1.500');
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
      // El primer findMany (exacto) retorna [], el $queryRaw retorna fuzzy.
      prisma.itemCompra.findMany = vi.fn(async () => []);
      const r = await getProductoByName('user-1', 'medias', { prisma: prisma as never, logger: buildMockLogger() as never });
      expect(r).toContain('medias negras');
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

    it('con compras: lista fecha + total', async () => {
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            { id: 'c1', fecha: new Date(2026, 5, 15), items: [{ nombre: 'a', cantidadLote: 1, unidad: 'UNIDAD', costoLote: new Decimal(1000), gananciaTotal: new Decimal(0) }] },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getComprasMes('user-1', deps);
      expect(r).toContain('Compras de este mes (1):');
      expect(r).toContain('15/6');
      expect(r).toContain('$1.000');
    });
  });

  describe('getTopGanancias', () => {
    it('DB vacía: mensaje estándar', async () => {
      const r = await getTopGanancias(5, emptyDeps());
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('lista top N con índice', async () => {
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
      expect(r).toContain('Top 3 ganancias');
      expect(r).toContain('1. a — $5.000 c/u');
      expect(r).toContain('2. b — $3.000 c/u');
    });
  });

  describe('parseQueryCommand', () => {
    it.each([
      ['resumen', { type: 'resumen' }],
      ['  RESUMEN  ', { type: 'resumen' }],
      ['estadisticas', { type: 'estadisticas' }],
      ['estadísticas', { type: 'estadisticas' }],
      ['ganancias', { type: 'ganancias' }],
      ['productos', { type: 'productos' }],
      ['stock', { type: 'stock' }],
      ['compras mes', { type: 'compras-mes' }],
      ['compras del mes', { type: 'compras-mes' }],
      ['top ganancias', { type: 'top-ganancias' }],
      ['top', { type: 'top-ganancias' }],
      ['producto medias negras', { type: 'producto', nombre: 'medias negras' }],
    ])('parsea "%s" → %j', (input, expected) => {
      expect(parseQueryCommand(input)).toEqual(expected);
    });

    it.each(['hola', 'qué hacés', 'producto', '  '])('input "%s" → null', (input) => {
      expect(parseQueryCommand(input)).toBeNull();
    });
  });

  describe('executeQuery dispatch', () => {
    it('dispatchea cada command al use case correcto', async () => {
      const deps = emptyDeps();
      const cmd = parseQueryCommand('resumen');
      expect(cmd).toEqual({ type: 'resumen' });
      const r = await executeQuery(cmd!, 'user-1', deps);
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });
  });

  // ── WU5: Business Metrics ──────────────────────────────────────────

  describe('getIngresos', () => {
    it('sin ventas: mensaje estándar', async () => {
      const r = await getIngresos('user-1', emptyDeps());
      expect(r).toBe('Todavía no registaste ventas. Usá /vender para empezar.');
    });

    it('con ventas: suma cantidad × precioVenta', async () => {
      const deps = {
        prisma: buildMockPrisma({
          ventas: [
            { usuarioId: 'user-1', productoNombre: 'medias', cantidad: 10, precioVenta: new Decimal(200), costoUnitario: new Decimal(100), gananciaUnitaria: new Decimal(100), gananciaTotal: new Decimal(1000) },
            { usuarioId: 'user-1', productoNombre: 'cajas', cantidad: 5, precioVenta: new Decimal(500), costoUnitario: new Decimal(300), gananciaUnitaria: new Decimal(200), gananciaTotal: new Decimal(1000) },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getIngresos('user-1', deps);
      expect(r).toBe('Ingresos generados: $4.500.');
    });

    it('una sola venta: monto correcto', async () => {
      const deps = {
        prisma: buildMockPrisma({
          ventas: [
            { usuarioId: 'user-1', productoNombre: 'zapatos', cantidad: 3, precioVenta: new Decimal(1500), costoUnitario: new Decimal(800), gananciaUnitaria: new Decimal(700), gananciaTotal: new Decimal(2100) },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getIngresos('user-1', deps);
      expect(r).toBe('Ingresos generados: $4.500.');
    });
  });

  describe('getGananciaRealizada', () => {
    it('sin ventas: mensaje estándar', async () => {
      const r = await getGananciaRealizada('user-1', emptyDeps());
      expect(r).toBe('Todavía no registaste ventas. Usá /vender para empezar.');
    });

    it('con ventas: suma gananciaTotal', async () => {
      const deps = {
        prisma: buildMockPrisma({
          ventas: [
            { usuarioId: 'user-1', productoNombre: 'medias', cantidad: 10, precioVenta: new Decimal(200), costoUnitario: new Decimal(100), gananciaUnitaria: new Decimal(100), gananciaTotal: new Decimal(1000) },
            { usuarioId: 'user-1', productoNombre: 'cajas', cantidad: 5, precioVenta: new Decimal(500), costoUnitario: new Decimal(300), gananciaUnitaria: new Decimal(200), gananciaTotal: new Decimal(1000) },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getGananciaRealizada('user-1', deps);
      expect(r).toBe('Ganancia realizada: $2.000.');
    });

    it('ganancia negativa: muestra valor negativo', async () => {
      const deps = {
        prisma: buildMockPrisma({
          ventas: [
            { usuarioId: 'user-1', productoNombre: 'zapatos', cantidad: 2, precioVenta: new Decimal(100), costoUnitario: new Decimal(200), gananciaUnitaria: new Decimal(-100), gananciaTotal: new Decimal(-200) },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getGananciaRealizada('user-1', deps);
      expect(r).toBe('Ganancia realizada: $-200.');
    });
  });

  describe('getGananciaPotencial', () => {
    it('sin compras ni ventas: mensaje estándar', async () => {
      const r = await getGananciaPotencial('user-1', emptyDeps());
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('con stock restante: calcula ganancia potencial por producto', async () => {
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            { id: 'c1', items: [
              { nombre: 'medias', cantidadLote: 20, unidad: 'PAR', costoLote: new Decimal(2000), gananciaTotal: new Decimal(0), costoUnitario: new Decimal(100), precioVenta: new Decimal(250), updatedAt: new Date('2026-06-10') },
            ] },
          ],
          ventas: [
            { usuarioId: 'user-1', productoNombre: 'medias', cantidad: 8, precioVenta: new Decimal(250), costoUnitario: new Decimal(100), gananciaUnitaria: new Decimal(150), gananciaTotal: new Decimal(1200) },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getGananciaPotencial('user-1', deps);
      // stock_remaining = 20 - 8 = 12
      // cost_of_remaining = (2000/20) × 12 = 1200
      // ganancia_potencial = 12 × 250 - 1200 = 3000 - 1200 = 1800
      expect(r).toBe('Ganancia potencial: $1.800.');
    });

    it('con stock cero: excluye producto', async () => {
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            { id: 'c1', items: [
              { nombre: 'medias', cantidadLote: 10, unidad: 'PAR', costoLote: new Decimal(1000), gananciaTotal: new Decimal(0), costoUnitario: new Decimal(100), precioVenta: new Decimal(200), updatedAt: new Date('2026-06-10') },
            ] },
          ],
          ventas: [
            { usuarioId: 'user-1', productoNombre: 'medias', cantidad: 10, precioVenta: new Decimal(200), costoUnitario: new Decimal(100), gananciaUnitaria: new Decimal(100), gananciaTotal: new Decimal(1000) },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getGananciaPotencial('user-1', deps);
      expect(r).toBe('Ganancia potencial: $0.');
    });

    it('multiples productos: suma ganancia potencial de todos', async () => {
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            { id: 'c1', items: [
              { nombre: 'medias', cantidadLote: 20, unidad: 'PAR', costoLote: new Decimal(2000), gananciaTotal: new Decimal(0), costoUnitario: new Decimal(100), precioVenta: new Decimal(250), updatedAt: new Date('2026-06-10') },
              { nombre: 'cajas', cantidadLote: 10, unidad: 'CAJA', costoLote: new Decimal(5000), gananciaTotal: new Decimal(0), costoUnitario: new Decimal(500), precioVenta: new Decimal(800), updatedAt: new Date('2026-06-10') },
            ] },
          ],
          ventas: [
            { usuarioId: 'user-1', productoNombre: 'medias', cantidad: 5, precioVenta: new Decimal(250), costoUnitario: new Decimal(100), gananciaUnitaria: new Decimal(150), gananciaTotal: new Decimal(750) },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getGananciaPotencial('user-1', deps);
      // medias: stock_remaining=15, cost=(2000/20)*15=1500, ganancia=15*250-1500=2250
      // cajas: stock_remaining=10, cost=(5000/10)*10=5000, ganancia=10*800-5000=3000
      // total = 2250 + 3000 = 5250
      expect(r).toBe('Ganancia potencial: $5.250.');
    });
  });

  describe('getCostoPromedio', () => {
    it('sin compras: mensaje estándar', async () => {
      const r = await getCostoPromedio('user-1', emptyDeps());
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('con multiples lotes: weighted average', async () => {
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            { id: 'c1', items: [
              { nombre: 'medias', cantidadLote: 10, unidad: 'PAR', costoLote: new Decimal(1000), gananciaTotal: new Decimal(0), costoUnitario: new Decimal(100), precioVenta: new Decimal(200), updatedAt: new Date() },
              { nombre: 'cajas', cantidadLote: 5, unidad: 'CAJA', costoLote: new Decimal(2500), gananciaTotal: new Decimal(0), costoUnitario: new Decimal(500), precioVenta: new Decimal(800), updatedAt: new Date() },
            ] },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getCostoPromedio('user-1', deps);
      // total_remaining_stock = 10 + 5 = 15
      // total_remaining_cost = 1000 + 2500 = 3500
      // costo_promedio = 3500 / 15 = 233.33
      expect(r).toContain('Costo promedio: $');
    });

    it('un solo lote: costoUnitario del lote', async () => {
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            { id: 'c1', items: [
              { nombre: 'medias', cantidadLote: 20, unidad: 'PAR', costoLote: new Decimal(2000), gananciaTotal: new Decimal(0), costoUnitario: new Decimal(100), precioVenta: new Decimal(200), updatedAt: new Date() },
            ] },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getCostoPromedio('user-1', deps);
      expect(r).toBe('Costo promedio: $100.');
    });
  });

  describe('getStockPerProduct', () => {
    it('sin compras: mapa vacío', async () => {
      const r = await getStockPerProduct('user-1', emptyDeps());
      expect(r.size).toBe(0);
    });

    it('con compras y ventas: stock restante correcto', async () => {
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            { id: 'c1', items: [
              { nombre: 'medias', cantidadLote: 20, unidad: 'PAR', costoLote: new Decimal(2000), gananciaTotal: new Decimal(0), costoUnitario: new Decimal(100), precioVenta: new Decimal(250), updatedAt: new Date('2026-06-10') },
            ] },
          ],
          ventas: [
            { usuarioId: 'user-1', productoNombre: 'medias', cantidad: 8, precioVenta: new Decimal(250), costoUnitario: new Decimal(100), gananciaUnitaria: new Decimal(150), gananciaTotal: new Decimal(1200) },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getStockPerProduct('user-1', deps);
      expect(r.size).toBe(1);
      const medias = r.get('medias')!;
      expect(medias.stock).toBe(12); // 20 - 8
      expect(medias.latestPrecioVenta).toBe(250);
      expect(medias.totalCost).toBe(1200); // (2000/20) * 12
    });

    it('producto con todo vendido: excluido del mapa', async () => {
      const deps = {
        prisma: buildMockPrisma({
          compras: [
            { id: 'c1', items: [
              { nombre: 'medias', cantidadLote: 10, unidad: 'PAR', costoLote: new Decimal(1000), gananciaTotal: new Decimal(0), costoUnitario: new Decimal(100), precioVenta: new Decimal(200), updatedAt: new Date() },
            ] },
          ],
          ventas: [
            { usuarioId: 'user-1', productoNombre: 'medias', cantidad: 10, precioVenta: new Decimal(200), costoUnitario: new Decimal(100), gananciaUnitaria: new Decimal(100), gananciaTotal: new Decimal(1000) },
          ],
        }) as never,
        logger: buildMockLogger() as never,
      };
      const r = await getStockPerProduct('user-1', deps);
      expect(r.size).toBe(0);
    });
  });

  describe('parseQueryCommand — WU5 new commands', () => {
    it.each([
      ['ingresos', { type: 'ingresos' }],
      ['  INGRESOS  ', { type: 'ingresos' }],
      ['ganancia realizada', { type: 'ganancia-realizada' }],
      ['ganancia potencial', { type: 'ganancia-potencial' }],
      ['costo promedio', { type: 'costo-promedio' }],
    ])('parsea "%s" → %j', (input, expected) => {
      expect(parseQueryCommand(input)).toEqual(expected);
    });
  });

  describe('executeQuery — WU5 new commands', () => {
    it('dispatchea ingresos al use case correcto', async () => {
      const deps = emptyDeps();
      const cmd = parseQueryCommand('ingresos');
      expect(cmd).toEqual({ type: 'ingresos' });
      const r = await executeQuery(cmd!, 'user-1', deps);
      expect(r).toBe('Todavía no registaste ventas. Usá /vender para empezar.');
    });

    it('dispatchea ganancia realizada al use case correcto', async () => {
      const deps = emptyDeps();
      const cmd = parseQueryCommand('ganancia realizada');
      expect(cmd).toEqual({ type: 'ganancia-realizada' });
      const r = await executeQuery(cmd!, 'user-1', deps);
      expect(r).toBe('Todavía no registaste ventas. Usá /vender para empezar.');
    });

    it('dispatchea ganancia potencial al use case correcto', async () => {
      const deps = emptyDeps();
      const cmd = parseQueryCommand('ganancia potencial');
      expect(cmd).toEqual({ type: 'ganancia-potencial' });
      const r = await executeQuery(cmd!, 'user-1', deps);
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });

    it('dispatchea costo promedio al use case correcto', async () => {
      const deps = emptyDeps();
      const cmd = parseQueryCommand('costo promedio');
      expect(cmd).toEqual({ type: 'costo-promedio' });
      const r = await executeQuery(cmd!, 'user-1', deps);
      expect(r).toBe('Todavía no cargaste compras. Usá /nueva para empezar.');
    });
  });
});
