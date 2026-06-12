/**
 * @compras-whatsapp/shared — ConversationState (const object).
 *
 * Fuente ÚNICA de verdad para los estados de la state machine. Vive
 * en shared porque es la dependencia base: el paquete `@compras-whatsapp/db`
 * lo re-exporta para mantener compatibilidad con código que ya hacía
 * `import { ConversationState } from '@compras-whatsapp/db'`.
 *
 * Los valores están sincronizados manualmente con el enum en
 * `packages/db/prisma/schema.prisma`. Si agregás un estado nuevo,
 * agregalo en AMBOS lados (Prisma y shared). La duplicación es
 * deliberada para evitar la dependencia circular shared → db → shared.
 */
export const ConversationState = {
  PREGUNTANDO_PRODUCTO: 'PREGUNTANDO_PRODUCTO',
  PREGUNTANDO_CANTIDAD: 'PREGUNTANDO_CANTIDAD',
  PREGUNTANDO_UNIDAD: 'PREGUNTANDO_UNIDAD',
  PREGUNTANDO_COSTO_LOTE: 'PREGUNTANDO_COSTO_LOTE',
  PREGUNTANDO_PRECIO_VENTA: 'PREGUNTANDO_PRECIO_VENTA',
  CONFIRMACION_FINAL: 'CONFIRMACION_FINAL',
  GUARDADO: 'GUARDADO',
  AGREGANDO_STOCK: 'AGREGANDO_STOCK',
} as const;

export type ConversationState = (typeof ConversationState)[keyof typeof ConversationState];
