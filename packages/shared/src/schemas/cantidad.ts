/**
 * @compras-whatsapp/shared — Zod schema para cantidad.
 *
 * Cantidad de unidades compradas en un lote. Validaciones:
 * - entero positivo (no aceptamos fracciones para cantidad de lote —
 *   "12.5 pares" no tiene sentido comercial).
 * - máximo 10000: protege contra typos ("999999" en vez de "12") y
 *   contra inputs maliciosos que inflen métricas.
 *
 * El schema se usa en los use cases de conversación (`AskCantidad`,
 * `ConfirmCompra`) y en las APIs de query (`GetComprasMes`).
 */
import { z } from 'zod';

export const cantidadSchema = z
  .number()
  .int('La cantidad tiene que ser un número entero.')
  .positive('La cantidad tiene que ser mayor a cero.')
  .max(10000, 'La cantidad no puede superar las 10000 unidades.');

export type Cantidad = z.infer<typeof cantidadSchema>;
