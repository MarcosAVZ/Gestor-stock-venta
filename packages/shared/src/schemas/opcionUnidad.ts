/**
 * @compras-whatsapp/shared — Zod schema para opción de unidad.
 *
 * Acepta la entrada del usuario en formato libre (case-insensitive,
 * con o sin acento, singular o plural) y la normaliza al enum
 * `Unidad` de Prisma. Vive en shared para que los use cases de
 * conversación (`AskUnidad`) lo consuman.
 *
 * Variantes aceptadas:
 *   - UNIDAD ↔ "unidad", "unidades", "u"
 *   - PAR    ↔ "par", "pares"
 *   - PACK   ↔ "pack", "packs"
 *   - CAJA   ↔ "caja", "cajas"
 *   - LOTE   ↔ "lote", "lotes"
 *   - OTRO   ↔ "otro", "otra"
 *
 * Si el input no matchea, el schema retorna `null` con mensaje
 * explicativo. El caller (use case) decide si re-preguntar al user
 * o tirar ValidationError.
 */
import { z } from 'zod';
import { Unidad } from '../enums/Unidad.ts';

const NORMALIZACIONES: Record<string, Unidad> = {
  unidad: Unidad.UNIDAD,
  unidades: Unidad.UNIDAD,
  u: Unidad.UNIDAD,
  par: Unidad.PAR,
  pares: Unidad.PAR,
  pack: Unidad.PACK,
  packs: Unidad.PACK,
  caja: Unidad.CAJA,
  cajas: Unidad.CAJA,
  lote: Unidad.LOTE,
  lotes: Unidad.LOTE,
  otro: Unidad.OTRO,
  otra: Unidad.OTRO,
};

export const opcionUnidadSchema = z
  .string()
  .min(1, 'Decime una unidad por favor.')
  .transform((raw, ctx) => {
    const lower = raw.toLowerCase().trim();
    const match = NORMALIZACIONES[lower];
    if (match === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unidad no reconocida: "${raw}". Usá: unidad, par, pack, caja u otro.`,
      });
      return z.NEVER;
    }
    return match;
  });

export type OpcionUnidad = z.infer<typeof opcionUnidadSchema>;
