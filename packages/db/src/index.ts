/**
 * @compras-whatsapp/db — punto de entrada público del paquete.
 *
 * Re-exporta el PrismaClient singleton y los tipos generados del schema.
 * Las implementaciones de los repositorios viven en apps/bot
 * (interfaces en domain, adapters Prisma en infrastructure).
 *
 * Convenciones:
 * - Importar tipos con `import type` para que type-stripping los borre.
 * - El runtime solo expone `prisma` y `disconnectPrisma`; todo lo demás
 *   es tipo puro.
 */

export { prisma, disconnectPrisma } from './client.ts';

// Re-exports de tipos generados por Prisma (puros, no runtime).
export type {
  Usuario,
  Compra,
  ItemCompra,
  Conversacion,
} from '@prisma/client';

// `Prisma` es a la vez namespace runtime (Prisma.sql, Prisma.empty,
// Prisma.PrismaClientKnownRequestError) y namespace de tipos
// (Prisma.InputJsonValue, Prisma.Sql). Lo re-exportamos como valor
// para que los adapters de repositorio puedan usar `Prisma.sql` para
// queries parametrizadas (req-prisma-schema) — los tipos quedan
// disponibles implícitamente al importarlo.
export { Prisma } from '@prisma/client';

// Enums (Prisma los emite como const objects en runtime, pero los
// re-exportamos como type + value para que el código de aplicación
// pueda hacer `Unidad.PAR` y `function foo(u: Unidad) {...}` sin
// doble import).
export {
  Unidad,
  Moneda,
  ConversationState,
} from '@prisma/client';
