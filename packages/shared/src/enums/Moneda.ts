/**
 * @compras-whatsapp/shared — Moneda (const object).
 *
 * Sincronizado con el enum `Moneda` del schema Prisma.
 */
export const Moneda = {
  ARS: 'ARS',
  USD: 'USD',
} as const;

export type Moneda = (typeof Moneda)[keyof typeof Moneda];
