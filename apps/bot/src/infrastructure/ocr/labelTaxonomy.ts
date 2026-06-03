/**
 * @compras-whatsapp/bot — Label taxonomy module.
 *
 * POR QUÉ EXISTE:
 * El parser OCR (`ocrParser.ts`) clasifica cada línea del texto
 * OCR en una categoría semántica (NOISE, PRICE_CURRENT, PRICE_OLD,
 * QUANTITY, NAME_CANDIDATE, LOTE_CONTENT) para entender qué número
 * significa qué. Este módulo es el **DICCIONARIO de labels** — la
 * fuente de verdad de qué palabras se reconocen como labels
 * válidos.
 *
 * ESTRUCTURA:
 * 1. **6 sets de labels** normalizados (lowercase, NFD-stripped).
 *    Los callers hacen `NOISE_SET.has(normalizeLabel(rawLabel))`
 *    para resolver un label raw a su categoría.
 * 2. **`LABEL_DETECTION_REGEX`** — union pattern de los 6 sets,
 *    usado por Pass 0 (label-detection scan) para decidir si el
 *    documento tiene labels (label-aware path) o no (legacy
 *    fallback).
 * 3. **`INLINE_BEFORE_AFTER_REGEX`** — pattern específico para la
 *    forma inline "Antes: $X / Ahora: $Y" en una sola línea
 *    (mitigación R3 del design §11).
 * 4. **`QUANTITY_XN_REGEX`** — pattern para el value-side de un
 *    label de cantidad (e.g., `Cantidad: x1` → captura el `1`).
 * 5. **`normalizeLabel(input)`** — helper de normalización
 *    (lowercase + NFD-strip + trim).
 *
 * TAXONOMÍA CERRADA EN v0:
 * La taxonomía es un conjunto CERRADO en v0 (no se agregan labels
 * por plataforma). Si una pantalla nueva no matchea, el parser
 * cae al fallback de la línea por línea (legacy). Labels nuevos
 * se agregan en cambios futuros, basados en fallos reales
 * observados. Esto es una decisión de scope (proposal §3).
 *
 * NORMALIZACIÓN:
 * Las claves de los 6 sets están en forma NFD-normalized
 * (lowercase, sin diacríticos). Esto es lo que devuelve
 * `normalizeLabel()`. Los callers que tengan un label raw de
 * Tesseract DEBEN llamar a `normalizeLabel()` antes de hacer
 * `.has()` en el set.
 *
 * TESTING:
 * El módulo es 100% puro (sin I/O, sin side effects, sin estado
 * módulo-level mutable — la regex compilada es una constante).
 * Todos los exports son testeables sin fixtures. La cobertura es
 * alta porque el módulo es la fuente de verdad del comportamiento
 * del parser.
 *
 * CAMBIO: `ocr-parser-label-aware` · WU2 — label taxonomy module.
 */

// ─────────────────────────────────────────────────────────────────────
// 1. Los 6 sets del diccionario (claves NFD-normalized).
// ─────────────────────────────────────────────────────────────────────

/**
 * Labels de RUIDO: la línea entera se ignora, no se emite producto.
 * Ejemplo típico: `Tienda: ZJ-SHIRUI` en una captura de Temu —
 * es metadata del vendedor, no del producto.
 */
export const NOISE_SET: ReadonlySet<string> = new Set([
  'tienda',
  'vendedor',
  'vendido por',
  'seguidores',
  'articulos',
  'productos de la tienda',
  'calificacion',
  'valoracion',
  'resenas',
  'envio',
  'envio gratis',
  'stock',
  'disponibilidad',
  'categoria',
  'marca',
  'color',
  'talla',
]);

/**
 * Labels de PRECIO ACTUAL (priority HIGH): candidatos a `precio`
 * del producto. El aggregator toma el primero en document order.
 */
export const PRICE_CURRENT_SET: ReadonlySet<string> = new Set([
  'precio del lote',
  'precio actual',
  'precio',
  'precio total',
  'total',
  'subtotal',
  'ahora',
  'precio ahora',
  'importe',
]);

/**
 * Labels de PRECIO ANTERIOR / TACHADO (priority LOW): nunca es la
 * respuesta correcta por sí solo. Solo se usa como tie-breaker o
 * se descarta si no hay un PRICE_CURRENT en el documento.
 */
export const PRICE_OLD_SET: ReadonlySet<string> = new Set([
  'precio anterior',
  'antes',
  'precio tachado',
  'precio original',
  'precio recomendado',
]);

/**
 * Labels de CANTIDAD: el value side es un número (con o sin
 * prefijo `x`, o un phrase `N unidades` / `N pares`).
 *
 * Los xN puros (e.g., `x1`, `x 2`, `X 3`) se matchean con
 * `QUANTITY_XN_REGEX`, no con este set — porque la regex captura
 * el dígito en group 1 y permite el matching case-insensitive.
 */
export const QUANTITY_KEYWORDS: ReadonlySet<string> = new Set([
  'cantidad comprada',
  'cantidad',
  'unidades',
  'pares',
]);

/**
 * Labels de NOMBRE CANDIDATO: el value side se trata como título
 * candidato del producto (por si no hay un NAME_CANDIDATE en la
 * misma línea que el precio).
 */
export const NAME_CANDIDATE_SET: ReadonlySet<string> = new Set([
  'producto',
  'titulo',
  'descripcion',
  'nombre',
  'detalle',
]);

/**
 * Labels de CONTENIDO DE LOTE (reserved for future, recognized in
 * v0): la línea se reconoce pero NO se parsea. La descomposición
 * de un LOTE en unidades individuales (`loteContenido`) es un
 * feature futuro — ver proposal §3.
 */
export const LOTE_CONTENT_SET: ReadonlySet<string> = new Set([
  'el lote incluye',
  'contiene',
  'incluye',
  'variante',
]);

// ─────────────────────────────────────────────────────────────────────
// 2. Regex patterns.
// ─────────────────────────────────────────────────────────────────────

/**
 * Regex para el **value-side** de un label de cantidad.
 *
 * Acepta `x1`, `x 1`, `X 2`, `x3` (case-insensitive, con o sin
 * espacio después de la x). El dígito se captura en group 1.
 *
 * El caller primero verifica que la línea entera matchea el label
 * (e.g., `Cantidad comprada`), luego aplica esta regex al residuo
 * post-label para extraer el número.
 *
 * Anclada con `^...$` (no es trailing, es value-side completa).
 */
export const QUANTITY_XN_REGEX: RegExp = /^\s*x\s*(\d+)\s*$/i;

/**
 * Regex para la forma INLINE `Antes: $X / Ahora: $Y` en una sola
 * línea.
 *
 * **Mitigación R3** (design §11): si una línea contiene AMBAS
 * keywords `antes` Y `ahora` con precios a cada lado, el caller
 * emite DOS `ClassifiedLine` sintéticos (uno `PRICE_OLD` y uno
 * `PRICE_CURRENT`) y los routea como si fueran dos líneas
 * separadas. Esto es distinto del caso de un `Antes:` standalone,
 * que se clasifica como `PRICE_OLD` single.
 *
 * El regex requiere AMBAS keywords y ambos precios. Si solo
 * aparece una keyword, NO matchea (la línea cae al branch de
 * label individual).
 *
 * Acepta separadores `:` (ASCII y fullwidth `：`) y `-`/`–`.
 */
export const INLINE_BEFORE_AFTER_REGEX: RegExp =
  /^\s*antes\s*[:：\-–]?\s*\$?\s*([\d.,]+)\s+ahora\s*[:：\-–]?\s*\$?\s*([\d.,]+)\s*$/i;

// ─────────────────────────────────────────────────────────────────────
// 3. LABEL_DETECTION_REGEX — Pass 0 union pattern.
// ─────────────────────────────────────────────────────────────────────

/**
 * Construye el union pattern para detectar CUALQUIER label al
 * inicio de una línea normalizada.
 *
 * Estrategia:
 * - **Sort por length DESC** — alternativas más largas matchean
 *   antes. Esto evita que `cantidad` capture el inicio de
 *   `cantidad comprada` y pierda la keyword larga.
 * - **Non-capturing alternation** `(?:...)`.
 * - **`\b` al final** — la keyword debe ser una palabra completa
 *   (e.g., `cantidad\b` no matchea `cantidades`).
 * - **`\s*[:：\-–]?` opcional** — el label puede tener o no
 *   separador (`:`, `：`, `-`, `–`).
 * - **Case-insensitive `/i`** — defensivo. El caller normaliza a
 *   lowercase, pero el flag previene surprises si el caller olvida.
 *
 * Pre-compilada una sola vez al module load (no per-line).
 */
function buildLabelDetectionRegex(): RegExp {
  // Union de los 6 sets — todas las claves en NFD-normalized form.
  const allKeys = [
    ...NOISE_SET,
    ...PRICE_CURRENT_SET,
    ...PRICE_OLD_SET,
    ...QUANTITY_KEYWORDS,
    ...NAME_CANDIDATE_SET,
    ...LOTE_CONTENT_SET,
  ];

  // Dedupe + sort por length DESC (más largo primero).
  const sortedKeys = [...new Set(allKeys)].sort(
    (a, b) => b.length - a.length,
  );

  // Escape special regex chars en cada clave (defensivo — los labels
  // actuales no tienen chars especiales, pero la función es trivial
  // y previene bugs si alguien agrega un label con `.` o `+` en
  // el futuro).
  const escapeRegex = (s: string): string =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const alternation = sortedKeys.map(escapeRegex).join('|');
  return new RegExp(`^\\s*(?:${alternation})\\b\\s*[:：\\-–]?`, 'i');
}

/**
 * Regex compilada (module load) que matchea una línea NORMALIZADA
 * cuyo inicio es un label conocido.
 *
 * **Uso por Pass 0** (label-detection scan en `ocrParser.ts`):
 * el caller hace `nfdNormalize(trimmed).match(LABEL_DETECTION_REGEX)`
 * para decidir si el documento contiene al menos un label. Si
 * matchea, va por el label-aware path; si no, fallback al legacy.
 */
export const LABEL_DETECTION_REGEX: RegExp = buildLabelDetectionRegex();

// ─────────────────────────────────────────────────────────────────────
// 4. normalizeLabel helper.
// ─────────────────────────────────────────────────────────────────────

/**
 * Normaliza un label raw a su forma canónica para lookup en los
 * sets.
 *
 * Transformaciones aplicadas (en este orden):
 * 1. **NFD-decompose + strip combining marks** — remueve
 *    diacríticos. `Categoría` → `Categoria`, `Calificación` →
 *    `Calificacion`.
 * 2. **Lowercase** — Tesseract a veces devuelve `TIENDA` o
 *    `Tienda`, queremos matchear ambos.
 * 3. **Trim** — whitespace al inicio y al final.
 *
 * **Por qué**:
 * - Tesseract varía la capitalización (ej: `Secciones` en vez de
 *   `secciones`). Case-insensitive lookup es defensivo.
 * - OCR en español suele entregar palabras con o sin tildes
 *   (depende del modelo, calidad de imagen, preproceso). NFD-strip
 *   normaliza `Categoría` y `Categoria` a la misma forma.
 *
 * **Edge case — la ñ**:
 * La ñ (U+00F1) es un char precomposed, NO se descompone con NFD
 * (su NFD es `n` + `˜` combining tilde, que SÍ se remueve). El
 * resultado es que `niño` → `nino`. Esto es consistente: el
 * diccionario de v0 NO contiene `ñ` en sus keys (los labels son
 * keywords, no nombres), así que este caso no surge en practice
 * — pero el comportamiento es correcto y predecible.
 *
 * @example
 * normalizeLabel('Precio del Lote')   // → 'precio del lote'
 * normalizeLabel('  Tienda  ')         // → 'tienda'
 * normalizeLabel('Categoría')          // → 'categoria'
 * normalizeLabel('niño')               // → 'nino'
 * normalizeLabel('  Atras  ')          // → 'atras'
 */
export function normalizeLabel(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}
