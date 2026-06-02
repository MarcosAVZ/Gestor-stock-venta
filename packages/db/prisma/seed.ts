/**
 * Seed script — datos mínimos para desarrollo local.
 *
 * Inserta:
 * - 1 Usuario demo (+5491100000000, nombre "Demo")
 * - 2 Compras con 1 item cada una
 * - 1 Conversacion en estado ESPERANDO_IMAGEN
 *
 * Idempotente: borra el usuario demo (cascade borra compras, items y
 * conversación) antes de insertar, así se puede correr varias veces.
 *
 * Ejecución:
 *   pnpm --filter @compras-whatsapp/db exec prisma db seed
 *
 * Requirements: DATABASE_URL apuntando a una DB con el schema aplicado
 * (no funciona sin migración previa). En el host actual Docker no está
 * instalado; este script queda listo para cuando la DB esté disponible.
 */

import { PrismaClient, Unidad, Moneda, ConversationState } from '@prisma/client';

const prisma = new PrismaClient();

const DEMO_PHONE = '+5491100000000';

async function main(): Promise<void> {
  // Limpieza idempotente: cascade borra compras, items, conversación.
  await prisma.usuario.deleteMany({ where: { telefono: DEMO_PHONE } });

  const demo = await prisma.usuario.create({
    data: {
      telefono: DEMO_PHONE,
      nombre: 'Demo',
    },
  });

  // Compra 1: 12 pares de medias negras a $1500 c/u (costoLote = 18000).
  await prisma.compra.create({
    data: {
      usuarioId: demo.id,
      moneda: Moneda.ARS,
      items: {
        create: [
          {
            nombre: 'medias negras',
            cantidadLote: 12,
            unidad: Unidad.PAR,
            costoLote: '18000.00',
            costoUnitario: '1500.0000',
            precioVenta: '2500.00',
            gananciaUnitaria: '1000.0000',
            gananciaTotal: '12000.00',
          },
        ],
      },
    },
  });

  // Compra 2: 30 paquetes de stickers a $500 c/u (costoLote = 15000).
  await prisma.compra.create({
    data: {
      usuarioId: demo.id,
      moneda: Moneda.ARS,
      items: {
        create: [
          {
            nombre: 'stickers kawaii',
            cantidadLote: 30,
            unidad: Unidad.PACK,
            costoLote: '15000.00',
            costoUnitario: '500.0000',
            precioVenta: '900.00',
            gananciaUnitaria: '400.0000',
            gananciaTotal: '12000.00',
          },
        ],
      },
    },
  });

  await prisma.conversacion.create({
    data: {
      usuarioId: demo.id,
      estado: ConversationState.ESPERANDO_IMAGEN,
      datosTemporales: {},
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    `Seed OK: usuario demo=${demo.id} (${demo.telefono}), 2 compras, 1 conversacion.`,
  );
}

main()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
