/**
 * Integration tests for the 4 Prisma repositories.
 *
 * ⚠️ ENTORNO: este host no tiene Docker, por lo que no podemos
 * levantar Postgres real. La validación contra `sgcw_test` queda
 * pendiente para cuando Docker esté disponible (target PR6 o
 * post-MVP). Por ahora mockeamos el `PrismaClientLike` con `vi.mock`
 * y verificamos que los adapters:
 *   1. Llaman al client con los argumentos correctos.
 *   2. Manejan correctamente el caso "not found" (devuelven null
 *      para find*; traducen P2025 a NotFoundError para update).
 *   3. Propagan excepciones del client sin envolverlas cuando
 *      no son código P2025.
 *
 * Para una suite de integración end-to-end real, ver
 * `tests/integration/repositories.real.test.ts` (a crear cuando
 * se disponga de Postgres + `DATABASE_URL_TEST`).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { Moneda, Unidad, ConversationState, Prisma } from '@compras-whatsapp/db';
import type { Compra, Conversacion, ItemCompra, Usuario } from '@compras-whatsapp/db';

import { PrismaCompraRepository } from '../../src/infrastructure/persistence/PrismaCompraRepository.ts';
import { PrismaConversacionRepository } from '../../src/infrastructure/persistence/PrismaConversacionRepository.ts';
import { PrismaItemCompraRepository } from '../../src/infrastructure/persistence/PrismaItemCompraRepository.ts';
import { PrismaUsuarioRepository } from '../../src/infrastructure/persistence/PrismaUsuarioRepository.ts';
import { NotFoundError } from '../../src/domain/errors/OperationalError.ts';

// ── Fixtures ─────────────────────────────────────────────────────────

const fakeUsuario: Usuario = {
  id: 'usr_abc',
  telefono: '+5491100000000',
  nombre: 'Demo',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const fakeCompra: Compra = {
  id: 'cmp_xyz',
  usuarioId: 'usr_abc',
  fecha: new Date('2026-01-15T00:00:00Z'),
  moneda: Moneda.ARS,
};

const fakeItem: ItemCompra = {
  id: 'itm_1',
  compraId: 'cmp_xyz',
  nombre: 'medias negras',
  cantidadLote: 12,
  unidad: Unidad.PAR,
  costoLote: new Prisma.Decimal('18000'),
  costoUnitario: new Prisma.Decimal('1500'),
  precioVenta: new Prisma.Decimal('2500'),
  gananciaUnitaria: new Prisma.Decimal('1000'),
  gananciaTotal: new Prisma.Decimal('12000'),
  updatedAt: new Date('2026-01-15T00:00:00Z'),
};

const fakeConversacion: Conversacion = {
  id: 'cnv_1',
  usuarioId: 'usr_abc',
  estado: ConversationState.PREGUNTANDO_PRODUCTO,
  datosTemporales: {},
  updatedAt: new Date('2026-01-15T00:00:00Z'),
  createdAt: new Date('2026-01-15T00:00:00Z'),
};

// ── Helpers ──────────────────────────────────────────────────────────

type MockClient = ReturnType<typeof buildMockClient>;

function buildMockClient(): {
  usuario: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  compra: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  itemCompra: {
    createMany: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  conversacion: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  $queryRaw: ReturnType<typeof vi.fn>;
} {
  return {
    usuario: { findUnique: vi.fn(), create: vi.fn() },
    compra: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    itemCompra: { createMany: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    conversacion: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    $queryRaw: vi.fn(),
  };
}

// ── PrismaUsuarioRepository ──────────────────────────────────────────

describe('PrismaUsuarioRepository (mocked client)', () => {
  let client: MockClient;
  let repo: PrismaUsuarioRepository;

  beforeEach(() => {
    client = buildMockClient();
    repo = new PrismaUsuarioRepository(client as unknown as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('findByTelefono calls findUnique with the right where', async () => {
    client.usuario.findUnique.mockResolvedValueOnce(fakeUsuario);
    const result = await repo.findByTelefono('+5491100000000');
    expect(client.usuario.findUnique).toHaveBeenCalledWith({
      where: { telefono: '+5491100000000' },
    });
    expect(result).toEqual(fakeUsuario);
  });

  test('findByTelefono returns null when not found (NOT throws)', async () => {
    client.usuario.findUnique.mockResolvedValueOnce(null);
    await expect(repo.findByTelefono('+5491199999999')).resolves.toBeNull();
  });

  test('findById calls findUnique with id where', async () => {
    client.usuario.findUnique.mockResolvedValueOnce(fakeUsuario);
    const result = await repo.findById('usr_abc');
    expect(client.usuario.findUnique).toHaveBeenCalledWith({ where: { id: 'usr_abc' } });
    expect(result).toEqual(fakeUsuario);
  });

  test('create passes data through to Prisma', async () => {
    client.usuario.create.mockResolvedValueOnce(fakeUsuario);
    const result = await repo.create({ telefono: '+5491100000000', nombre: 'Demo' });
    expect(client.usuario.create).toHaveBeenCalledWith({
      data: { telefono: '+5491100000000', nombre: 'Demo' },
    });
    expect(result).toEqual(fakeUsuario);
  });
});

// ── PrismaCompraRepository ───────────────────────────────────────────

describe('PrismaCompraRepository (mocked client)', () => {
  let client: MockClient;
  let repo: PrismaCompraRepository;

  beforeEach(() => {
    client = buildMockClient();
    repo = new PrismaCompraRepository(client as unknown as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('create forwards data', async () => {
    client.compra.create.mockResolvedValueOnce(fakeCompra);
    const result = await repo.create({ usuarioId: 'usr_abc' });
    expect(client.compra.create).toHaveBeenCalledWith({ data: { usuarioId: 'usr_abc' } });
    expect(result).toEqual(fakeCompra);
  });

  test('findById returns null when not found', async () => {
    client.compra.findUnique.mockResolvedValueOnce(null);
    await expect(repo.findById('cmp_nope')).resolves.toBeNull();
  });

  test('findByIdWithItems uses include: { items: true }', async () => {
    client.compra.findUnique.mockResolvedValueOnce({ ...fakeCompra, items: [fakeItem] });
    await repo.findByIdWithItems('cmp_xyz');
    expect(client.compra.findUnique).toHaveBeenCalledWith({
      where: { id: 'cmp_xyz' },
      include: { items: true },
    });
  });

  test('findByUsuarioId defaults limit to 100 and orders desc by fecha', async () => {
    client.compra.findMany.mockResolvedValueOnce([fakeCompra]);
    await repo.findByUsuarioId('usr_abc');
    expect(client.compra.findMany).toHaveBeenCalledWith({
      where: { usuarioId: 'usr_abc' },
      orderBy: { fecha: 'desc' },
      take: 100,
    });
  });

  test('findByDateRange uses gte/lte and orderBy desc', async () => {
    client.compra.findMany.mockResolvedValueOnce([fakeCompra]);
    const from = new Date('2026-01-01');
    const to = new Date('2026-01-31');
    await repo.findByDateRange({ from, to });
    expect(client.compra.findMany).toHaveBeenCalledWith({
      where: { fecha: { gte: from, lte: to } },
      orderBy: { fecha: 'desc' },
    });
  });

  test('findTopByGanancias orders by gananciaUnitaria desc and limits', async () => {
    // Este método usa el delegate `itemCompra` (no `compra`) con un cast
    // interno. El mock solo necesita responder en `itemCompra.findMany`.
    client.itemCompra.findMany.mockResolvedValueOnce([fakeItem]);
    await repo.findTopByGanancias(5);
    expect(client.itemCompra.findMany).toHaveBeenCalledWith({
      orderBy: { gananciaUnitaria: 'desc' },
      take: 5,
    });
  });
});

// ── PrismaItemCompraRepository ───────────────────────────────────────

describe('PrismaItemCompraRepository (mocked client)', () => {
  let client: MockClient;
  let repo: PrismaItemCompraRepository;

  beforeEach(() => {
    client = buildMockClient();
    repo = new PrismaItemCompraRepository(client as unknown as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('createMany inserts and re-fetches by compraId', async () => {
    client.itemCompra.createMany.mockResolvedValueOnce({ count: 1 });
    client.itemCompra.findMany.mockResolvedValueOnce([fakeItem]);

    const items = [
      {
        compraId: 'cmp_xyz',
        nombre: 'medias negras',
        cantidadLote: 12,
        unidad: Unidad.PAR,
        costoLote: '18000.00',
        costoUnitario: '1500.0000',
        precioVenta: '2500.00',
        gananciaUnitaria: '1000.0000',
        gananciaTotal: '12000.00',
      },
    ];
    const result = await repo.createMany(items);
    expect(client.itemCompra.createMany).toHaveBeenCalledWith({ data: items });
    expect(client.itemCompra.findMany).toHaveBeenCalledWith({
      where: { compraId: { in: ['cmp_xyz'] } },
      orderBy: { updatedAt: 'desc' },
    });
    expect(result).toEqual([fakeItem]);
  });

  test('findByNombre lowercases the input', async () => {
    client.itemCompra.findMany.mockResolvedValueOnce([fakeItem]);
    await repo.findByNombre('Medias NEGRAS');
    expect(client.itemCompra.findMany).toHaveBeenCalledWith({
      where: { nombre: 'medias negras' },
    });
  });

  test('findRecentByNombre uses pg_trgm.similarity with Prisma.sql template', async () => {
    client.$queryRaw.mockResolvedValueOnce([{ ...fakeItem, similarity: 0.62 }]);
    const result = await repo.findRecentByNombre('medias negra');
    // El client fue llamado con un Prisma.Sql (objeto), no string. Verificamos
    // que se llamó y que el segundo parámetro (normalized input) está.
    expect(client.$queryRaw).toHaveBeenCalled();
    const callArgs = client.$queryRaw.mock.calls[0] ?? [];
    // El primer arg es Prisma.Sql (objeto con .strings/.values).
    // Solo verificamos que se pasó el nombre normalizado como valor.
    const allArgs = callArgs as unknown[];
    const serialized = JSON.stringify(allArgs);
    expect(serialized).toContain('medias negra');
    expect(result?.similarity).toBeCloseTo(0.62);
  });

  test('findRecentByNombre returns null when no rows match', async () => {
    client.$queryRaw.mockResolvedValueOnce([]);
    const result = await repo.findRecentByNombre('xyz123');
    expect(result).toBeNull();
  });

  test('findRecentByNombre allows overriding the similarity threshold', async () => {
    client.$queryRaw.mockResolvedValueOnce([]);
    await repo.findRecentByNombre('foo', 0.7);
    const callArgs = (client.$queryRaw.mock.calls[0] ?? []) as unknown[];
    const serialized = JSON.stringify(callArgs);
    // 0.7 debe estar como valor en la query, no el default 0.4.
    expect(serialized).toContain('0.7');
  });
});

// ── PrismaConversacionRepository ─────────────────────────────────────

describe('PrismaConversacionRepository (mocked client)', () => {
  let client: MockClient;
  let repo: PrismaConversacionRepository;

  beforeEach(() => {
    client = buildMockClient();
    repo = new PrismaConversacionRepository(client as unknown as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('findByUsuarioId returns null when no conversation exists', async () => {
    client.conversacion.findUnique.mockResolvedValueOnce(null);
    await expect(repo.findByUsuarioId('usr_abc')).resolves.toBeNull();
  });

  test('upsert creates with default state when no state provided', async () => {
    client.conversacion.upsert.mockResolvedValueOnce(fakeConversacion);
    await repo.upsert({ usuarioId: 'usr_abc' });
    expect(client.conversacion.upsert).toHaveBeenCalledWith({
      where: { usuarioId: 'usr_abc' },
      create: {
        usuarioId: 'usr_abc',
  estado: ConversationState.PREGUNTANDO_PRODUCTO,
        datosTemporales: {},
      },
      update: {},
    });
  });

  test('upsert updates only the fields that were provided', async () => {
    client.conversacion.upsert.mockResolvedValueOnce({
      ...fakeConversacion,
      estado: ConversationState.PREGUNTANDO_CANTIDAD,
    });
    await repo.upsert({
      usuarioId: 'usr_abc',
      estado: ConversationState.PREGUNTANDO_CANTIDAD,
    });
    expect(client.conversacion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { usuarioId: 'usr_abc' },
        update: { estado: ConversationState.PREGUNTANDO_CANTIDAD },
      }),
    );
  });

  test('update throws NotFoundError when Prisma returns P2025', async () => {
    const p2025 = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    client.conversacion.update.mockRejectedValueOnce(p2025);

    await expect(
      repo.update('usr_ghost', { estado: ConversationState.PREGUNTANDO_CANTIDAD }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test('update propagates non-P2025 errors as-is', async () => {
    const dbError = new Error('connection lost');
    client.conversacion.update.mockRejectedValueOnce(dbError);

    await expect(
      repo.update('usr_abc', { estado: ConversationState.PREGUNTANDO_CANTIDAD }),
    ).rejects.toBe(dbError);
  });

  test('update builds data with only the fields provided', async () => {
    client.conversacion.update.mockResolvedValueOnce(fakeConversacion);
    await repo.update('usr_abc', { datosTemporales: { foo: 'bar' } });
    expect(client.conversacion.update).toHaveBeenCalledWith({
      where: { usuarioId: 'usr_abc' },
      data: { datosTemporales: { foo: 'bar' } },
    });
  });
});

/**
 * ⏭️ Real-DB integration tests placeholder.
 *
 * Cuando Docker esté disponible, crear tests/integration/repositories.real.test.ts
 * con la siguiente forma:
 *
 *   import { PrismaClient } from '@compras-whatsapp/db';
 *   const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
 *
 *   beforeEach: `await prisma.$executeRaw\`TRUNCATE "ItemCompra", "Compra", "Conversacion", "Usuario" CASCADE;\``
 *   afterAll:    `await prisma.$disconnect()`
 *
 *   test cases:
 *     - cascade: borrar Usuario borra Compra + items + Conversacion
 *     - unique:  crear dos usuarios con mismo telefono tira P2002
 *     - fuzzy:   con seed cargado, findRecentByNombre('medias') retorna 1 item con similarity > 0.4
 *     - upsert:  Conversacion upsert crea la primera vez, actualiza la segunda
 *     - P2025:   Conversacion.update sobre usuario inexistente tira NotFoundError
 */
