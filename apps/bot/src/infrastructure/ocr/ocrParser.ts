/**
 * Parser heurístico de texto OCR → `OCRResult` con `productos`.
 *
 * POR QUÉ ESTE ARCHIVO:
 * Tesseract devuelve `textoCompleto` (string raw). El use case
 * `ExtractPurchaseData` necesita una lista estructurada de productos
 * con nombre, precio, cantidad y unidad. Acá aplicamos heurísticas
 * regex para extraerlos. NO usamos NLP/ML: el dominio es acotado
 * (capturas de shopping con precio + descripción) y queremos algo
 * testeable y explicable.
 *
 * ESTRATEGIA:
 * 1. Split por líneas (Tesseract devuelve una línea por producto en
 *    el 90% de los casos).
 * 2. Para cada línea:
 *    a. Extraer precios (regex con heurística de separador decimal).
 *    b. Extraer cantidad + unidad (regex de unidades en español).
 *    c. El resto de la línea = nombre del producto (trim + max 60).
 *    d. Si hay precio y nombre, emitir un `OCRProduct`.
 * 3. Si una línea tiene varios precios, emitir un producto por precio.
 * 4. Cap de `MAX_PRODUCTOS` por OCR (defensa contra OCR garbage
 *    que matchea muchos falsos positivos).
 *
 * HEURÍSTICA DE PRECIO:
 * - Formatos soportados: `$1.234,56`, `AR$ 1234.56`, `ARS 1.234,56`,
 *   `1234,50`, `1234.50`, `$1234`, `1234`.
 * - Regla: el ÚLTIMO separador (`.` o `,`) seguido de 1-2 dígitos
 *   es el decimal. Si tiene 3+ dígitos o no hay dígitos después,
 *   todos los separadores son miles.
 *
 * DECISIÓN DE DISEÑO (sdd-design obs#28 §4.3):
 * El parser es PURO (no llama al OCR). Eso permite:
 * - Re-parsear `textoCompleto` sin re-correr Tesseract.
 * - Testear con fixtures sintéticas (no levantar WASM).
 * - Evolucionar heurísticas sin tocar infra.
 *
 * Si la heurística falla, devuelve `productos: []` con `textoCompleto`
 * intacto. El use case decide qué hacer (probablemente re-preguntar
 * al usuario o reintentar OCR con otra configuración).
 */

import {
  type OCRProduct,
  type OCRResult,
  type Unidad,
  UnidadSchema,
} from '@compras-whatsapp/shared';

import {
  LABEL_DETECTION_REGEX,
  LOTE_CONTENT_SET,
  NAME_CANDIDATE_SET,
  NOISE_SET,
  PRICE_CURRENT_SET,
  PRICE_OLD_SET,
  QUANTITY_KEYWORDS,
  QUANTITY_XN_REGEX,
  normalizeLabel,
} from './labelTaxonomy.ts';

/** Tope de productos por OCR (defensa contra falsos positivos). */
const MAX_PRODUCTOS = 10;
/** Tope de chars para `nombre` (Zod no lo enforcea, pero el display
 *  y la DB tienen límites prácticos). */
const MAX_NOMBRE_CHARS = 60;

/** Mapa palabra → enum Unidad del Prisma. */
const UNIT_KEYWORDS: Record<string, Unidad> = {
  unidad: 'UNIDAD',
  unidades: 'UNIDAD',
  un: 'UNIDAD',
  u: 'UNIDAD',
  par: 'PAR',
  pares: 'PAR',
  pack: 'PACK',
  packs: 'PACK',
  caja: 'CAJA',
  cajas: 'CAJA',
};

/** Regex de precio: prefijo OPCIONAL (AR$, ARS, $) + número con
 *  separadores. Captura solo el token numérico en grupo 1. El
 *  prefijo es opcional para poder parsear líneas como
 *  `Medias\n1234,50` (capturas de Temu sin símbolo de moneda). */
const PRICE_REGEX =
  /(?:(?:AR\s*\$\s*|ARS\s+|\$)\s*)?(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g;

/** Regex de cantidad: número + unidad en español.
 *  OJO: `pares?` en regex = `pares`|`pare` (NO `par`). Por eso
 *  usamos `par(?:es)?` y `unidad(?:es)?` para que matcheen tanto
 *  singular como plural. */
const QTY_REGEX =
  /(\d+)\s+(par(?:es)?|unidad(?:es)?|packs?|cajas?)\b/gi;

/** Regex de "2x producto" (cantidad implícita al inicio). */
const LEADING_QTY_REGEX = /^(\d+)\s*[xX*]\s+/;

interface ParsedPrice {
  value: number;
  /** Token crudo capturado (incluyendo prefijo). */
  raw: string;
  /** Offset dentro de la línea. */
  index: number;
  /** Largo del token capturado. */
  length: number;
}

/**
 * Normaliza un token numérico a `number`. Aplica la heurística
 * de separador decimal: el último `.` o `,` seguido de 1-2 dígitos
 * es el decimal; cualquier otro separador es miles.
 *
 * Devuelve `null` si el token no es parseable o es <= 0.
 */
function legacyParsePriceToken(token: string): number | null {
  if (token.length === 0) return null;

  const lastDot = token.lastIndexOf('.');
  const lastComma = token.lastIndexOf(',');
  const lastSep = Math.max(lastDot, lastComma);
  const sepChar = lastSep === -1 ? null : (token[lastSep] as '.' | ',');

  let normalized: string;
  if (lastSep === -1) {
    // Sin separadores: solo dígitos
    normalized = token;
  } else {
    const after = token.slice(lastSep + 1);
    if (/^\d{1,2}$/.test(after) && sepChar !== null) {
      // El último separador es el decimal
      if (sepChar === ',') {
        // AR style: . = miles, , = decimal
        normalized = token.replace(/\./g, '').replace(',', '.');
      } else {
        // US style: , = miles, . = decimal
        normalized = token.replace(/,/g, '');
      }
    } else {
      // No hay decimal: todos los separadores son miles
      normalized = token.replace(/[.,]/g, '');
    }
  }

  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function legacyExtractPricesFromLine(line: string): ParsedPrice[] {
  const out: ParsedPrice[] = [];
  PRICE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PRICE_REGEX.exec(line)) !== null) {
    const token = match[1]!;
    const value = legacyParsePriceToken(token);
    if (value !== null) {
      // Calculamos el offset del número (no del prefijo) dentro del
      // match. match[0] incluye el prefijo, así que usamos
      // match.index + (match[0].length - token.length) como
      // aproximación; sin embargo queremos el offset del match
      // completo para poder borrarlo de la línea.
      out.push({
        value,
        raw: match[0],
        index: match.index,
        length: match[0].length,
      });
    }
  }
  return out;
}

function legacyExtractQuantityFromLine(
  line: string,
): { cantidad: number; unidad: Unidad } | null {
  QTY_REGEX.lastIndex = 0;
  const m = QTY_REGEX.exec(line);
  if (m === null) return null;
  const cantidad = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(cantidad) || cantidad <= 0) return null;
  const unitWord = m[2]!.toLowerCase();
  const unidad = UNIT_KEYWORDS[unitWord] ?? 'OTRO';
  // Validamos contra el enum (defensa en profundidad)
  const parsed = UnidadSchema.parse(unidad);
  return { cantidad, unidad: parsed };
}

/** "2x Producto" — cantidad al inicio de la línea. */
function legacyExtractLeadingQuantity(line: string): {
  cantidad: number;
  rest: string;
} | null {
  const m = line.match(LEADING_QTY_REGEX);
  if (m === null) return null;
  const cantidad = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(cantidad) || cantidad <= 0) return null;
  return { cantidad, rest: line.slice(m[0].length) };
}

function legacyCleanName(raw: string): string {
  let s = raw;
  // Quitar prefijos de moneda residuales
  s = s.replace(/(?:AR\s*\$|ARS|\$)/g, ' ');
  // Quitar números sueltos (precios, cantidades) y separadores
  s = s.replace(/\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?/g, ' ');
  s = s.replace(/\d+/g, ' ');
  // Quitar unidades en español
  s = s.replace(/\b(?:unidades?|pares?|packs?|cajas?)\b/gi, ' ');
  // Quitar "x" suelta
  s = s.replace(/\s*[xX*]\s*/g, ' ');
  // Colapsar espacios y trim
  s = s.replace(/\s+/g, ' ').trim();
  // Quitar separadores/puntuación sueltos al inicio/fin
  s = s.replace(/^[\s.,;:_\-–—|/\\]+/, '').replace(/[\s.,;:_\-–—|/\\]+$/, '');
  if (s.length > MAX_NOMBRE_CHARS) {
    s = s.slice(0, MAX_NOMBRE_CHARS).trim();
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────
// Label-aware path (cambio `ocr-parser-label-aware` · WU3).
//
// Esta sección implementa Pass 1 (line classifier) del label-aware
// path. El aggregator (Pass 2) y el dispatch desde `parseOCRText`
// (Pass 0) se agregan en tasks siguientes (T3.3, T3.4). Por ahora,
// `parseOCRText` sigue usando el path legacy de `parseLinesLegacy` y el
// T3.1 Temu test sigue RED — esto es por diseño, la clasificación
// se introduce ANTES del wiring para poder testear las unidades
// puras en isolation.
//
// PASS 1 — `classifyLine(line)`:
// Para cada línea no-vacía, detecta el label al inicio (NFD-normalized
// para tolerar acentos y casing), y emite UN `ClassifiedLine` con la
// categoría semántica y el value extraído. El aggregator (Pass 2) los
// consumirá en document order. La detección es determinística y pura:
// no muta estado, no llama al OCR, no toca el DOM.
// ─────────────────────────────────────────────────────────────────────

/** Categoría semántica de una línea OCR. */
export type LabelType =
  | 'NOISE'
  | 'PRICE_CURRENT'
  | 'PRICE_OLD'
  | 'QUANTITY'
  | 'NAME_CANDIDATE'
  | 'LOTE_CONTENT'
  | 'UNKNOWN';

/** Shape del `value` de un `ClassifiedLine` — depende del `label`. */
export type ClassifiedValue =
  | number
  | { cantidad: number; unidad: Unidad }
  | string
  | null;

/** Línea OCR clasificada: la línea cruda + su categoría semántica
 *  + el value extraído (forma depende del label). */
export interface ClassifiedLine {
  raw: string;
  label: LabelType;
  value: ClassifiedValue;
}

/** Construye un regex per-set que captura el label matcheado (group 1)
 *  y el residuo (group 2).
 *
 *  Dos problemas a resolver:
 *  1. **Longest-match**: en regex alternation, JS es leftmost-greedy,
 *     no longest. Ordenamos por length DESC y usamos un lookahead
 *     estricto que requiere un separador (`:`/`：`/`-`/`–`) o fin de
 *     string después del label — esto evita que `precio` (PRICE_CURRENT)
 *     matchee el inicio de `precio anterior` (PRICE_OLD) cuando el
 *     siguiente char es space + otra letra.
 *  2. **Case + diacritics**: los labels en el set están en NFD
 *     normalizada (lowercase, sin diacríticos). El caller debe pasar
 *     la línea YA normalizada (usando `normalizeLabel`).
 */
function makeSetRegex(set: ReadonlySet<string>): RegExp {
  const sortedKeys = [...set].sort((a, b) => b.length - a.length);
  const escapeRegex = (s: string): string =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternation = sortedKeys.map(escapeRegex).join('|');
  // El lookahead `(?=\s*[:：\-–]|$)` requiere que el label sea
  // seguido por un separator (con optional whitespace) o fin de
  // input. Sin este lookahead, `precio` matchearía `precioX`
  // (precio + X) — X no es word boundary y no es separador.
  return new RegExp(
    `^\\s*(${alternation})(?=\\s*[:：\\-–]|$)\\s*[:：\\-–]?\\s*(.*)$`,
    'i',
  );
}

/** Regex per-set (pre-compiladas al module load). */
const NOISE_LINE_REGEX = makeSetRegex(NOISE_SET);
const PRICE_CURRENT_LINE_REGEX = makeSetRegex(PRICE_CURRENT_SET);
const PRICE_OLD_LINE_REGEX = makeSetRegex(PRICE_OLD_SET);
const QUANTITY_LINE_REGEX = makeSetRegex(QUANTITY_KEYWORDS);
const NAME_CANDENT_LINE_REGEX = makeSetRegex(NAME_CANDIDATE_SET);
const LOTE_CONTENT_LINE_REGEX = makeSetRegex(LOTE_CONTENT_SET);

/**
 * Clasifica una línea OCR individual.
 *
 * Algoritmo (Pass 1 del label-aware path, design §4):
 * 1. Trim de la línea.
 * 2. Si está vacía → UNKNOWN.
 * 3. NFD-normalize para el matching de labels.
 * 4. Probar cada set en orden de prioridad:
 *    NOISE → PRICE_CURRENT → PRICE_OLD → QUANTITY
 *    → NAME_CANDIDATE → LOTE_CONTENT.
 * 5. Para PRICE_CURRENT/PRICE_OLD: extraer el primer precio del
 *    residuo. Si no hay precio parseable, demote a NAME_CANDIDATE
 *    (la línea no se pierde — el aggregator la trata como name
 *    candidate).
 * 6. Para QUANTITY: probar `QUANTITY_XN_REGEX` (e.g., `x1`) primero;
 *    si no, probar la regex de cantidad con palabra de unidad
 *    (e.g., `2 unidades`). Si no parsea, demote a NAME_CANDIDATE.
 * 7. Si ningún set matchea → UNKNOWN (la línea se routea a través
 *    del legacy row processor dentro del aggregator).
 *
 * El `raw` field del resultado preserva la línea ORIGINAL
 * (post-trim, con casing original) — el matching usa el NFD pero
 * el output es el raw.
 */
export function classifyLine(line: string): ClassifiedLine {
  const raw = line.trim();
  if (raw.length === 0) {
    return { raw, label: 'UNKNOWN', value: raw };
  }
  const nfd = normalizeLabel(raw);

  let m: RegExpExecArray | null;

  m = NOISE_LINE_REGEX.exec(nfd);
  if (m !== null) return { raw, label: 'NOISE', value: null };

  m = PRICE_CURRENT_LINE_REGEX.exec(nfd);
  if (m !== null) {
    // m[2] es el residuo post-label en NFD form. La regex de precio
    // (PRICE_REGEX) tiene un prefix opcional (AR$/ARS/$) y matchea
    // el número; la case del prefix no afecta al match del número
    // (los dígitos son case-invariant). Por simplicidad, usamos m[2]
    // directamente para la extracción de precio.
    const rest = m[2] ?? '';
    const prices = legacyExtractPricesFromLine(rest);
    if (prices.length > 0) {
      return { raw, label: 'PRICE_CURRENT', value: prices[0]!.value };
    }
    return { raw, label: 'NAME_CANDIDATE', value: rest };
  }

  m = PRICE_OLD_LINE_REGEX.exec(nfd);
  if (m !== null) {
    const rest = m[2] ?? '';
    const prices = legacyExtractPricesFromLine(rest);
    if (prices.length > 0) {
      return { raw, label: 'PRICE_OLD', value: prices[0]!.value };
    }
    return { raw, label: 'NAME_CANDIDATE', value: rest };
  }

  m = QUANTITY_LINE_REGEX.exec(nfd);
  if (m !== null) {
    const rest = m[2] ?? '';
    // Primero probar xN (`x1`, `X 2`, `x 3`).
    const xnMatch = rest.match(QUANTITY_XN_REGEX);
    if (xnMatch !== null) {
      const cantidad = Number.parseInt(xnMatch[1]!, 10);
      return { raw, label: 'QUANTITY', value: { cantidad, unidad: 'UNIDAD' } };
    }
    // Si no, probar `N unidades` / `N pares` / etc.
    const qtyWordMatch = rest.match(QTY_REGEX);
    if (qtyWordMatch !== null) {
      const cantidad = Number.parseInt(qtyWordMatch[1]!, 10);
      if (Number.isFinite(cantidad) && cantidad > 0) {
        const unitWord = qtyWordMatch[2]!.toLowerCase();
        const unidad = UNIT_KEYWORDS[unitWord] ?? 'OTRO';
        return {
          raw,
          label: 'QUANTITY',
          value: { cantidad, unidad: UnidadSchema.parse(unidad) },
        };
      }
    }
    return { raw, label: 'NAME_CANDIDATE', value: rest };
  }

  m = NAME_CANDENT_LINE_REGEX.exec(nfd);
  if (m !== null) {
    const rest = m[2] ?? '';
    return { raw, label: 'NAME_CANDIDATE', value: rest };
  }

  m = LOTE_CONTENT_LINE_REGEX.exec(nfd);
  if (m !== null) {
    const rest = m[2] ?? '';
    return { raw, label: 'LOTE_CONTENT', value: rest };
  }

  return { raw, label: 'UNKNOWN', value: raw };
}

/**
 * Parsea `textoCompleto` y devuelve una lista de `OCRProduct`.
 *
 * Estrategia cross-line con look-ahead (necesaria porque Tesseract
 * suele separar nombre, precio y cantidad en líneas distintas):
 *
 * Para cada línea del texto:
 * 1. Si NO tiene precio NI cantidad → es un nombre candidato.
 *    Se guarda como `pendingName` para usar con el próximo precio.
 * 2. Si tiene cantidad pero NO precio → se guarda como
 *    `pendingQty` (ej: "2 unidades" puede estar en una línea
 *    separada del precio).
 * 3. Si tiene precio:
 *    a. Se busca el nombre: en la misma línea (limpiando precios)
 *       o en `pendingName` (línea anterior sin precio).
 *    b. Se busca la cantidad: en la misma línea, en `pendingQty`
 *       (qty en línea anterior), o en la SIGUIENTE línea si
 *       tiene qty sin precio (look-ahead de 1 línea).
 *    c. Si hay nombre válido, se emite un producto por cada precio.
 *    d. Se limpia `pendingName` y `pendingQty` (consumidos).
 *
 * El cap de `MAX_PRODUCTOS` se respeta incluso si quedan más
 * productos por emitir (defensa contra OCR garbage).
 */
function parseLinesLegacy(lines: string[]): OCRProduct[] {
  const productos: OCRProduct[] = [];
  let pendingName: string | null = null;
  let pendingQty: { cantidad: number; unidad: Unidad } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    if (productos.length >= MAX_PRODUCTOS) break;
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;

    const prices = legacyExtractPricesFromLine(trimmed);
    const qtyOnLine = legacyExtractQuantityFromLine(trimmed);

    if (prices.length === 0) {
      // Sin precio en esta línea.
      if (qtyOnLine !== null) {
        // Cantidad sola: candidato a aplicar al próximo precio.
        pendingQty = qtyOnLine;
      } else {
        // Texto sin números significativos: nombre candidato.
        pendingName = trimmed;
      }
      continue;
    }

    // Tenemos precio(s). Determinar nombre y cantidad.

    // Look-ahead: si la siguiente línea no-vacía tiene qty (con o
    // sin "precio" falso-positivo tipo "1 par"), la asociamos a
    // ESTE producto. PRIORIZAMOS qty sobre price match.
    let lookaheadQty: { cantidad: number; unidad: Unidad } | null = null;
    if (qtyOnLine === null && pendingQty === null) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j += 1) {
        const nextTrim = (lines[j] ?? '').trim();
        if (nextTrim.length === 0) continue;
        // Primero chequear qty (puede ser "1 par" que también matchea
        // como precio de "1" — el qty gana).
        const nextQty = legacyExtractQuantityFromLine(nextTrim);
        if (nextQty !== null) {
          lookaheadQty = nextQty;
          break;
        }
        // Si no hay qty pero hay un "precio" claro (con separador),
        // paramos: la siguiente línea es un producto nuevo.
        const nextPrices = legacyExtractPricesFromLine(nextTrim);
        const hasRealPrice = nextPrices.some((p) => /[.,]/.test(p.raw));
        if (hasRealPrice) break;
        // Texto sin números: paramos (no es qty).
        break;
      }
    }

    // Nombre: limpiar la línea actual; si queda vacío, usar pendingName.
    let nameSource = trimmed;
    for (let k = prices.length - 1; k >= 0; k -= 1) {
      const p = prices[k]!;
      nameSource = nameSource.slice(0, p.index) + nameSource.slice(p.index + p.length);
    }
    let nombre = legacyCleanName(nameSource);
    if (nombre.length === 0 && pendingName !== null) {
      nombre = legacyCleanName(pendingName);
    }

    // Leading quantity: "2x Producto" al inicio de la línea de precio.
    const leading = legacyExtractLeadingQuantity(trimmed);

    // Cantidad: priorizamos qty-en-misma-línea, luego leading,
    // luego pending, luego look-ahead.
    const cantidad =
      qtyOnLine?.cantidad ??
      leading?.cantidad ??
      pendingQty?.cantidad ??
      lookaheadQty?.cantidad ??
      1;
    const unidad: Unidad =
      qtyOnLine?.unidad ??
      pendingQty?.unidad ??
      lookaheadQty?.unidad ??
      'UNIDAD';

    if (nombre.length === 0) {
      // No hay nombre: descartar (Zod requiere min(1)).
      pendingName = null;
      pendingQty = null;
      continue;
    }

    // Emitir un producto por cada precio.
    for (const p of prices) {
      if (productos.length >= MAX_PRODUCTOS) break;
      productos.push({
        nombre,
        precio: p.value,
        cantidad,
        unidad,
        // Confianza heurística: 0.7 (el parser no mide confianza
        // propia; el caller usa `confianzaPromedio` del OCR para
        // ajustar).
        confianza: 0.7,
      });
    }

    // Consumimos el pending (un nombre/qty se aplica solo al
    // primer precio de la línea).
    pendingName = null;
    pendingQty = null;
  }

  return productos;
}

/**
 * Pass 0 (label-detection scan) del label-aware path (design §3).
 *
 * Devuelve `true` si AL MENOS una línea no-vacía del documento
 * contiene un label conocido al inicio (NFD-normalized + tested
 * contra `LABEL_DETECTION_REGEX`).
 *
 * Es la decisión que hace `parseOCRText`:
 * - `true` → el documento es e-commerce-shape (Temu / ML / Shein) →
 *   usar el label-aware path.
 * - `false` → el documento es receipt-shape (sin labels) → usar el
 *   legacy line-by-line path. Este es el fallback que preserva
 *   byte-for-byte el comportamiento de `parseLines` legacy.
 *
 * Es cheap: un solo pass lineal, una regex test por línea no-vacía.
 * El caller ya spliteó `textoCompleto` por líneas; recibimos `lines`.
 */
function detectAnyLabel(lines: string[]): boolean {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const nfd = normalizeLabel(trimmed);
    if (LABEL_DETECTION_REGEX.test(nfd)) return true;
  }
  return false;
}

/**
 * Pass 2 (label-aware aggregator) — STUB en T3.3.
 *
 * Se implementa en T3.4 (la siguiente task). Por ahora devuelve
 * `[]` para que el dispatch de `parseOCRText` esté wired pero el
 * label-aware path todavía no haga nada — así los tests de
 * receipt-shape (legacy fallback) siguen pasando byte-for-byte
 * aunque el Temu test siga RED (esperado: el stub ignora los
 * labels del Temu).
 */
function parseLinesLabelAware(_lines: string[]): OCRProduct[] {
  return [];
}

/**
 * Punto de entrada: parsea el `textoCompleto` de un `OCRResult` y
 * devuelve un NUEVO `OCRResult` con `productos` poblado.
 *
 * El `OCRResult` original (tiempoMs, confianzaPromedio, textoCompleto)
 * se preserva; solo `productos` se reemplaza.
 *
 * ARQUITECTURA (cambio `ocr-parser-label-aware` · WU3):
 * Tres stages (Pass 0, Pass 1, Pass 2) con un verbatim legacy
 * fallback para receipt-shape input:
 *
 *   Pass 0 (detectAnyLabel) → decide el path:
 *     ├── NO labels → parseLinesLegacy (verbatim copy de
 *     │                parseLines pre-cambio) — preserva el
 *     │                comportamiento de receipt-shape byte-for-byte.
 *     └── HAS labels → parseLinesLabelAware (stub en T3.3,
 *                     implementación en T3.4).
 *
 *   Pass 1 (classifyLine) — pure function, exportada para testing.
 *   Pass 2 (parseLinesLabelAware internamente) — consume los
 *           ClassifiedLine[] y produce OCRProduct[].
 *
 * Defensa R1: `parseLinesLegacy` es una copia byte-for-byte del
 * `parseLines` pre-cambio. No se refactorizó. Los 16+ tests de
 * receipt-shape son el contrato — si alguno falla después de un
 * cambio al legacy, el refactor rompió algo.
 */
export function parseOCRText(raw: OCRResult): OCRResult {
  const lines = raw.textoCompleto.split(/\r?\n/);
  const hasLabels = detectAnyLabel(lines);
  const productos = hasLabels
    ? parseLinesLabelAware(lines)
    : parseLinesLegacy(lines);

  return {
    ...raw,
    productos,
  };
}
