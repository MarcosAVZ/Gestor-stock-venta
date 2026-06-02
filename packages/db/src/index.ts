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

// Enums: la fuente única de verdad es `@compras-whatsapp/shared`
// (PR5). Prisma los genera con los mismos valores desde el schema
// (sincronización manual — ver `shared/src/enums/`). Re-exportamos
// desde shared para mantener compatibilidad con el código que ya
// hacía `import { Unidad } from '@compras-whatsapp/db'`.
export { Unidad, Moneda, ConversationState } from '@compras-whatsapp/shared';
// Re-exportar los tipos también (TS borra el import type en strip).
export type { Unidad as UnidadType, Moneda as MonedaType } from '@compras-whatsapp/shared';
