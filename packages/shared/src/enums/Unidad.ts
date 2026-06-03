/**
 * @compras-whatsapp/shared — Unidad (const object).
 *
 * Unidad de venta de un producto. Los valores están sincronizados con
 * el enum `Unidad` del schema de Prisma. Ver header de
 * `ConversationState.ts` para el rationale de la duplicación deliberada.
 */
export const Unidad = {
  UNIDAD: 'UNIDAD',
  PAR: 'PAR',
  PACK: 'PACK',
  CAJA: 'CAJA',
  LOTE: 'LOTE',
  OTRO: 'OTRO',
} as const;

export type Unidad = (typeof Unidad)[keyof typeof Unidad];
/** Alias para callers que prefieren el sufijo Type. */
export type UnidadType = Unidad;
