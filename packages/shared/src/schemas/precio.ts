/**
 * @compras-whatsapp/shared — Zod schema para precio de venta.
 *
 * Acepta DOS formas de input del usuario:
 *   1. **número** (`number`): ej: `1500`, `1500.5`, `1.5`
 *   2. **string ARS** (`string`): ej: `"$1500"`, `"AR$ 1.500,00"`,
 *      `"1500"`, `"6.000"`, `"6,000"`, `"ARS 1.500"`. El schema
 *      normaliza separadores de miles (`.` o `,`) y el símbolo de
 *      moneda. `1.500` se interpreta como mil quinientos (formato AR),
 *      NO como uno coma cinco. Esto es deliberado: en es-AR el
 *      separador de miles es `.` y el decimal es `,`.
 *
 * Por qué la lógica de parseo está acá y no en cada use case: queremos
 * UNA sola fuente de verdad para "qué es un precio válido" (OWASP A03
 * — input validation). Si en el futuro agregamos USD con punto decimal,
 * se actualiza este schema y todos los use cases se benefician.
 *
 * El upper bound 10.000.000 ARS protege contra typos y ataques: nadie
 * vende un par de medias a 10 millones de pesos (precios mayoristas
 * típicos en Temu/Shein/ML son < 100.000 ARS por unidad).
 */
import { z } from 'zod';

const MAX_PRECIO_ARS = 10_000_000;

/**
 * Parsea un string con formato ARS libre a número.
 * - Remueve `$`, `AR$`, `ARS`, `USD` (case-insensitive).
 * - Remueve espacios.
 * - Si tiene AMBOS `.` y `,`: el ÚLTIMO es el separador decimal,
 *   el resto son miles. `1.234,56` → 1234.56, `1,234.56` → 1234.56.
 * - Si tiene SOLO `.`: si hay más de un `.` o el grupo después del
 *   `.` tiene exactamente 3 dígitos, es separador de miles → 1500.
 *   Si tiene UN solo `.` y el grupo tiene 1-2 dígitos, es decimal
 *   → 1500.5. Esta heurística cubre los formatos comunes en es-AR.
 * - Si tiene SOLO `,`: si hay más de una `,` o la única tiene
 *   exactamente 3 dígitos, es separador de miles → 1500. Si la
 *   única tiene 1-2 dígitos, es decimal → 1500.5.
 * - Si no tiene ni `.` ni `,`: número entero directo.
 */
function parsePrecioString(raw: string): number {
  // Limpieza: remover prefijos de moneda, símbolos, espacios.
  const cleaned = raw
    .replace(/AR\$|ARS|USD|\$/gi, '')
    .replace(/\s+/g, '')
    .trim();
  if (cleaned === '') {
    throw new Error('Precio vacío');
  }

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');

  if (hasDot && hasComma) {
    // El ÚLTIMO (rightmost) separador es el decimal; el otro es miles.
    // - "1.500,50" → rightmost = "," → formato AR → "." son miles.
    // - "1,500.50" → rightmost = "." → formato US → "," son miles.
    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');
    if (lastDot > lastComma) {
      // Rightmost es "." → formato US. Las "," son miles.
      return Number(cleaned.replace(/,/g, ''));
    }
    // Rightmost es "," → formato AR. Los "." son miles.
    return Number(cleaned.replace(/\./g, '').replace(',', '.'));
  }

  if (hasDot) {
    const parts = cleaned.split('.');
    if (parts.length > 2) {
      // "1.500.000" → separador de miles
      return Number(cleaned.replace(/\./g, ''));
    }
    // parts.length === 2
    const decimals = parts[1] ?? '';
    if (decimals.length === 3) {
      // "1.500" → separador de miles (es-AR)
      return Number(cleaned.replace('.', ''));
    }
    // Decimal (1.5, 12.99) — convertir a formato JS
    return Number(cleaned);
  }

  if (hasComma) {
    const parts = cleaned.split(',');
    if (parts.length > 2) {
      // "1,500,000" → separador de miles
      return Number(cleaned.replace(/,/g, ''));
    }
    const decimals = parts[1] ?? '';
    if (decimals.length === 3) {
      // "1,500" → separador de miles (es-AR)
      return Number(cleaned.replace(',', ''));
    }
    // Decimal (1,5) — convertir a "1.5"
    return Number(cleaned.replace(',', '.'));
  }

  return Number(cleaned);
}

/**
 * Schema principal. Acepta `number` directo o `string` parseable.
 * Internamente coerce a `number` para que el downstream siempre
 * reciba un número.
 */
export const precioSchema = z.union([z.number(), z.string()]).transform((val, ctx) => {
  let n: number;
  if (typeof val === 'number') {
    n = val;
  } else {
    try {
      n = parsePrecioString(val);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Precio inválido: "${val}" no se pudo interpretar como número.`,
      });
      return z.NEVER;
    }
  }
  if (!Number.isFinite(n)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Precio inválido: no se pudo convertir a número.',
    });
    return z.NEVER;
  }
  if (n <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'El precio tiene que ser mayor a cero.',
    });
    return z.NEVER;
  }
  if (n > MAX_PRECIO_ARS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `El precio no puede superar los $${MAX_PRECIO_ARS.toLocaleString('es-AR')}.`,
    });
    return z.NEVER;
  }
  return n;
});

export type Precio = z.infer<typeof precioSchema>;

/** Helper público para tests: re-exporta el parser de strings. */
export { parsePrecioString };

/** Límite máximo exportado para que callers puedan mostrar mensajes consistentes. */
export const MAX_PRECIO_ARS_VALUE = MAX_PRECIO_ARS;
