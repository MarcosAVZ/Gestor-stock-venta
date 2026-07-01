/**
 * Subset estructural del PrismaClient que los adapters de repositorio
 * consumen. Se declara localmente para que los tests con `vi.mock`
 * solo necesiten mockear este subset, no el client completo.
 *
 * Compatible con `PrismaClient` real (duck typing sobre los métodos
 * efectivamente usados). Cualquier método nuevo que un adapter agregue
 * debe reflejarse acá — TS fallará al pasar el client real si el
 * adapter usa algo no declarado.
 */

import type { Moneda, Unidad, Usuario, ItemCompra, Venta } from '@compras-whatsapp/db';

export type CompraWithItems = {
  id: string;
  usuarioId: string;
  fecha: Date;
  imagenOriginal: string | null;
  moneda: Moneda;
  items: ItemCompra[];
};

export type PrismaClientLike = {
  usuario: {
    findUnique: (args: { where: { telefono: string } | { id: string } }) => Promise<Usuario | null>;
    findFirst: (args: { select?: unknown; where?: unknown }) => Promise<unknown>;
    create: (args: { data: { telefono: string; nombre?: string } }) => Promise<Usuario>;
  };
  compra: {
    create: (args: {
      data: {
        usuarioId: string;
        imagenOriginal?: string;
        moneda?: Moneda;
      };
    }) => Promise<unknown>;
    findUnique: (args: {
      where: { id: string };
      include?: { items?: boolean };
    }) => Promise<CompraWithItems | null>;
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy?: { fecha?: 'asc' | 'desc' };
      take?: number;
      include?: { items?: boolean };
    }) => Promise<unknown[]>;
    deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
  };
  itemCompra: {
    createMany: (args: { data: NewItemCompraRow[] }) => Promise<{ count: number }>;
    findMany: (args: {
      where: unknown;
      orderBy?: unknown;
      take?: number;
      select?: unknown;
      include?: unknown;
    }) => Promise<unknown[]>;
    findFirst: (args: { where: unknown; orderBy?: unknown }) => Promise<unknown>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
  };
  conversacion: {
    findUnique: (args: { where: { usuarioId: string } }) => Promise<unknown>;
    upsert: (args: {
      where: { usuarioId: string };
      create: { usuarioId: string; estado?: unknown; datosTemporales?: unknown };
      update: { estado?: unknown; datosTemporales?: unknown };
    }) => Promise<unknown>;
    update: (args: { where: { usuarioId: string }; data: unknown }) => Promise<unknown>;
  };
  venta: {
    create: (args: { data: VentaCreateInput }) => Promise<Venta>;
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'>;
      take?: number;
    }) => Promise<Venta[]>;
    count: (args: { where: Record<string, unknown> }) => Promise<number>;
    aggregate: (args: {
      where: Record<string, unknown>;
      _sum?: Record<string, boolean>;
    }) => Promise<unknown>;
  };
  $queryRaw: ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>) & ((
    sql: { strings: string[]; values: unknown[] },
  ) => Promise<unknown>);
  $transaction: <T>(fn: (tx: PrismaClientLike) => Promise<T>) => Promise<T>;
};

/** Row que `createMany` espera para cada ItemCompra. */
export type NewItemCompraRow = {
  compraId: string;
  nombre: string;
  cantidadLote: number;
  unidad: Unidad;
  costoLote: string;
  costoUnitario: string;
  precioVenta: string;
  gananciaUnitaria: string;
  gananciaTotal: string;
};

/** Input para crear una Venta via Prisma. */
export type VentaCreateInput = {
  usuarioId: string;
  productoNombre: string;
  cantidad: number;
  precioVenta: string;
  costoUnitario: string;
  gananciaUnitaria: string;
  gananciaTotal: string;
};

