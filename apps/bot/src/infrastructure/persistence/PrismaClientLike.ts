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

import type { Moneda, Unidad, Usuario, ItemCompra } from '@compras-whatsapp/db';
import type { Prisma } from '@compras-whatsapp/db';

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
    }) => Promise<unknown[]>;
  };
  itemCompra: {
    createMany: (args: { data: NewItemCompraRow[] }) => Promise<{ count: number }>;
    findMany: (args: {
      where: unknown;
      orderBy?: unknown;
      take?: number;
    }) => Promise<unknown[]>;
    findFirst: (args: { where: unknown; orderBy?: unknown }) => Promise<unknown>;
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
  $queryRaw: (query: Prisma.Sql, ...values: unknown[]) => Promise<unknown>;
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

