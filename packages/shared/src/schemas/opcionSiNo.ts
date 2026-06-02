/**
 * @compras-whatsapp/shared — Zod schema para respuesta sí/no del usuario.
 *
 * Normaliza las múltiples formas en que un usuario puede responder
 * "sí" o "no" a una pregunta del bot:
 *   - sí:   "si", "sí", "s", "yes", "y", "ok", "dale", "1"
 *   - no:   "no", "n", "mal", "incorrecto", "2"
 *
 * Si la respuesta no matchea ninguna variante, retorna error con
 * mensaje claro para re-preguntar.
 */
import { z } from 'zod';

const SI = new Set(['si', 'sí', 's', 'yes', 'y', 'ok', 'dale', '1']);
const NO = new Set(['no', 'n', 'mal', 'incorrecto', '2']);

export const opcionSiNoSchema = z
  .string()
  .min(1, 'Respondé sí o no por favor.')
  .transform((raw, ctx) => {
    const lower = raw.toLowerCase().trim();
    if (SI.has(lower)) return 'si' as const;
    if (NO.has(lower)) return 'no' as const;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `No entendí tu respuesta: "${raw}". Decime sí o no.`,
    });
    return z.NEVER;
  });

export type OpcionSiNo = z.infer<typeof opcionSiNoSchema>;

/** Helpers booleanos (true = sí, false = no). */
export const SI_TEXTO = 'si' as const;
export const NO_TEXTO = 'no' as const;
