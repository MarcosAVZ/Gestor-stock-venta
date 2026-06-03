/**
 * Tests unitarios de `apps/bot/src/infrastructure/ocr/labelTaxonomy.ts`.
 *
 * Cubren:
 * - Estructura de los 6 sets del diccionario (`NOISE_SET`,
 *   `PRICE_CURRENT_SET`, `PRICE_OLD_SET`, `QUANTITY_KEYWORDS`,
 *   `NAME_CANDIDATE_SET`, `LOTE_CONTENT_SET`) — listas exactas del
 *   design §4.2 / proposal §4.2.
 * - `normalizeLabel`: lowercasing + NFD (sin diacríticos) + trim.
 * - `QUANTITY_XN_REGEX`: trailing xN en value-side de un label.
 * - `INLINE_BEFORE_AFTER_REGEX`: línea con AMBAS keywords `antes` y
 *   `ahora` con precios; NO matchea si solo aparece una (mitigación R3).
 * - `LABEL_DETECTION_REGEX`: union de los 6 sets para Pass 0
 *   (label-detection scan).
 *
 * Este test file es el ancla de WU2 (label taxonomy module) del change
 * `ocr-parser-label-aware`. El módulo destino es NUEVO en este ciclo —
 * los tests son RED al principio porque el archivo no existe.
 *
 * Las claves de los 6 sets son NORMALIZADAS (lowercase, NFD-stripped).
 * Los callers hacen `NOISE_SET.has(normalizeLabel(rawLabel))` para
 * resolver un label raw a su categoría.
 */

import { describe, expect, it } from 'vitest';

import {
  INLINE_BEFORE_AFTER_REGEX,
  LABEL_DETECTION_REGEX,
  LOTE_CONTENT_SET,
  NAME_CANDIDATE_SET,
  NOISE_SET,
  PRICE_CURRENT_SET,
  PRICE_OLD_SET,
  QUANTITY_KEYWORDS,
  QUANTITY_XN_REGEX,
  normalizeLabel,
} from '../../src/infrastructure/ocr/labelTaxonomy.ts';

describe('labelTaxonomy — NOISE_SET (skip-the-line labels)', () => {
  it('contiene los 17 labels de ruido normalizados (lowercase + sin diacríticos)', () => {
    // Las claves están en NFD-normalized form: lowercase, sin tildes.
    expect(NOISE_SET.has('tienda')).toBe(true);
    expect(NOISE_SET.has('vendedor')).toBe(true);
    expect(NOISE_SET.has('vendido por')).toBe(true);
    expect(NOISE_SET.has('seguidores')).toBe(true);
    expect(NOISE_SET.has('articulos')).toBe(true);
    expect(NOISE_SET.has('productos de la tienda')).toBe(true);
    expect(NOISE_SET.has('calificacion')).toBe(true);
    expect(NOISE_SET.has('valoracion')).toBe(true);
    expect(NOISE_SET.has('resenas')).toBe(true);
    expect(NOISE_SET.has('envio')).toBe(true);
    expect(NOISE_SET.has('envio gratis')).toBe(true);
    expect(NOISE_SET.has('stock')).toBe(true);
    expect(NOISE_SET.has('disponibilidad')).toBe(true);
    expect(NOISE_SET.has('categoria')).toBe(true);
    expect(NOISE_SET.has('marca')).toBe(true);
    expect(NOISE_SET.has('color')).toBe(true);
    expect(NOISE_SET.has('talla')).toBe(true);
  });

  it('NO contiene un label que pertenece a otra categoría (separación de sets)', () => {
    expect(NOISE_SET.has('precio')).toBe(false);
    expect(NOISE_SET.has('cantidad')).toBe(false);
    expect(NOISE_SET.has('producto')).toBe(false);
    expect(NOISE_SET.has('incluye')).toBe(false);
  });

  it('NO contiene el form con tilde (las claves están normalizadas)', () => {
    expect(NOISE_SET.has('artículos')).toBe(false);
    expect(NOISE_SET.has('calificación')).toBe(false);
    expect(NOISE_SET.has('categoría')).toBe(false);
  });
});

describe('labelTaxonomy — PRICE_CURRENT_SET (priority HIGH)', () => {
  it('contiene los 9 labels de precio actual', () => {
    expect(PRICE_CURRENT_SET.has('precio del lote')).toBe(true);
    expect(PRICE_CURRENT_SET.has('precio actual')).toBe(true);
    expect(PRICE_CURRENT_SET.has('precio')).toBe(true);
    expect(PRICE_CURRENT_SET.has('precio total')).toBe(true);
    expect(PRICE_CURRENT_SET.has('total')).toBe(true);
    expect(PRICE_CURRENT_SET.has('subtotal')).toBe(true);
    expect(PRICE_CURRENT_SET.has('ahora')).toBe(true);
    expect(PRICE_CURRENT_SET.has('precio ahora')).toBe(true);
    expect(PRICE_CURRENT_SET.has('importe')).toBe(true);
  });

  it('NO contiene un label de precio anterior (separación de sets)', () => {
    expect(PRICE_CURRENT_SET.has('precio anterior')).toBe(false);
    expect(PRICE_CURRENT_SET.has('antes')).toBe(false);
  });
});

describe('labelTaxonomy — PRICE_OLD_SET (priority LOW)', () => {
  it('contiene los 5 labels de precio tachado / anterior', () => {
    expect(PRICE_OLD_SET.has('precio anterior')).toBe(true);
    expect(PRICE_OLD_SET.has('antes')).toBe(true);
    expect(PRICE_OLD_SET.has('precio tachado')).toBe(true);
    expect(PRICE_OLD_SET.has('precio original')).toBe(true);
    expect(PRICE_OLD_SET.has('precio recomendado')).toBe(true);
  });

  it('NO contiene "ahora" (ese es PRICE_CURRENT)', () => {
    expect(PRICE_OLD_SET.has('ahora')).toBe(false);
  });
});

describe('labelTaxonomy — QUANTITY_KEYWORDS (cantidad labels)', () => {
  it('contiene los 4 keywords de cantidad (los xN van por regex aparte)', () => {
    expect(QUANTITY_KEYWORDS.has('cantidad comprada')).toBe(true);
    expect(QUANTITY_KEYWORDS.has('cantidad')).toBe(true);
    expect(QUANTITY_KEYWORDS.has('unidades')).toBe(true);
    expect(QUANTITY_KEYWORDS.has('pares')).toBe(true);
  });

  it('NO contiene "x1" (los xN se matchean con QUANTITY_XN_REGEX)', () => {
    expect(QUANTITY_KEYWORDS.has('x1')).toBe(false);
    expect(QUANTITY_KEYWORDS.has('x 1')).toBe(false);
  });
});

describe('labelTaxonomy — NAME_CANDIDATE_SET (product title candidates)', () => {
  it('contiene los 5 labels de nombre candidato', () => {
    expect(NAME_CANDIDATE_SET.has('producto')).toBe(true);
    expect(NAME_CANDIDATE_SET.has('titulo')).toBe(true);
    expect(NAME_CANDIDATE_SET.has('descripcion')).toBe(true);
    expect(NAME_CANDIDATE_SET.has('nombre')).toBe(true);
    expect(NAME_CANDIDATE_SET.has('detalle')).toBe(true);
  });
});

describe('labelTaxonomy — LOTE_CONTENT_SET (reserved for future, recognized in v0)', () => {
  it('contiene los 4 labels de contenido de lote', () => {
    expect(LOTE_CONTENT_SET.has('el lote incluye')).toBe(true);
    expect(LOTE_CONTENT_SET.has('contiene')).toBe(true);
    expect(LOTE_CONTENT_SET.has('incluye')).toBe(true);
    expect(LOTE_CONTENT_SET.has('variante')).toBe(true);
  });
});

describe('labelTaxonomy — normalizeLabel', () => {
  it('lowercase el input', () => {
    expect(normalizeLabel('Precio del Lote')).toBe('precio del lote');
  });

  it('NFD-decompone y remueve combining diacritics (tilde en "niño" → "nino")', () => {
    // La ñ NO se descompone con NFD (es un char precomposed, no
    // n + ˜) — pero la tilde en "Calificación" / "Categoría" SÍ.
    expect(normalizeLabel('niño')).toBe('nino');
  });

  it('NFD-strip en palabras con tilde (Categoría → categoria)', () => {
    expect(normalizeLabel('Categoría')).toBe('categoria');
    expect(normalizeLabel('Calificación')).toBe('calificacion');
    expect(normalizeLabel('Artículos')).toBe('articulos');
  });

  it('trims whitespace al inicio y al final', () => {
    expect(normalizeLabel('  Atras  ')).toBe('atras');
  });

  it('compone las 3 transformaciones (trim + lowercase + NFD-strip)', () => {
    expect(normalizeLabel('  TIENDA  ')).toBe('tienda');
    expect(normalizeLabel('  Calificación  ')).toBe('calificacion');
  });
});

describe('labelTaxonomy — QUANTITY_XN_REGEX (value-side xN)', () => {
  it('matchea "x 1" con espacio después de la x', () => {
    expect(QUANTITY_XN_REGEX.test('x 1')).toBe(true);
  });

  it('matchea "X 2" (uppercase) case-insensitivamente', () => {
    expect(QUANTITY_XN_REGEX.test('X 2')).toBe(true);
  });

  it('matchea "x3" sin espacio después de la x', () => {
    expect(QUANTITY_XN_REGEX.test('x3')).toBe(true);
  });

  it('captura el dígito en group 1', () => {
    const m = 'x 1'.match(QUANTITY_XN_REGEX);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('1');
  });

  it('NO matchea un string que no es xN (la regex es anchored value-side)', () => {
    // La regex se aplica al value-side de un label de cantidad (no
    // como trailing regex), por eso está anchored con ^...$. Falla
    // si no hay dígito, si hay letras mezcladas, o si el x no es el
    // primer char no-whitespace.
    expect(QUANTITY_XN_REGEX.test('x abc')).toBe(false);
    expect(QUANTITY_XN_REGEX.test('12x34')).toBe(false);
    expect(QUANTITY_XN_REGEX.test('x')).toBe(false);
  });
});

describe('labelTaxonomy — INLINE_BEFORE_AFTER_REGEX (R3: Antes/Ahora on same line)', () => {
  it('matchea una línea con AMBAS keywords "Antes:" y "Ahora:" + ambos precios', () => {
    expect(INLINE_BEFORE_AFTER_REGEX.test('Antes: $100  Ahora: $80')).toBe(true);
  });

  it('matchea la misma línea sin el símbolo $ (solo dígitos)', () => {
    expect(INLINE_BEFORE_AFTER_REGEX.test('Antes: 100  Ahora: 80')).toBe(true);
  });

  it('captura el precio "antes" en group 1 y el "ahora" en group 2', () => {
    const m = 'Antes: $100  Ahora: $80'.match(INLINE_BEFORE_AFTER_REGEX);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('100');
    expect(m![2]).toBe('80');
  });

  it('NO matchea "Antes: $100" solo (falta la keyword "ahora")', () => {
    // Mitigación R3: si solo aparece "antes", NO es inline; es un
    // label "antes" standalone (que cae en PRICE_OLD, no en el
    // branch sintético de inline). Debe distinguirse.
    expect(INLINE_BEFORE_AFTER_REGEX.test('Antes: $100')).toBe(false);
  });

  it('NO matchea "Ahora: $80" solo (falta la keyword "antes")', () => {
    expect(INLINE_BEFORE_AFTER_REGEX.test('Ahora: $80')).toBe(false);
  });
});

describe('labelTaxonomy — LABEL_DETECTION_REGEX (Pass 0: ¿hay algún label en esta línea?)', () => {
  // El caller normaliza la línea con NFD antes de aplicar la regex,
  // por eso los inputs de test ya están en form normalizado
  // (lowercase, sin diacríticos).

  it('detecta un label NOISE al inicio de la línea', () => {
    expect(LABEL_DETECTION_REGEX.test('tienda: zj-shirui')).toBe(true);
  });

  it('detecta un label PRICE_CURRENT', () => {
    expect(LABEL_DETECTION_REGEX.test('precio del lote: ars$33.928')).toBe(true);
  });

  it('detecta un label PRICE_OLD', () => {
    expect(LABEL_DETECTION_REGEX.test('precio anterior: ars$53.385')).toBe(true);
  });

  it('detecta un label QUANTITY', () => {
    expect(LABEL_DETECTION_REGEX.test('cantidad: 1')).toBe(true);
  });

  it('detecta un label NAME_CANDIDATE', () => {
    expect(LABEL_DETECTION_REGEX.test('producto: 2 pares de calcetines')).toBe(true);
  });

  it('detecta un label LOTE_CONTENT multi-palabra ("el lote incluye")', () => {
    expect(LABEL_DETECTION_REGEX.test('el lote incluye: 10 pares de gatos')).toBe(true);
  });

  it('detecta un label multi-palabra con espacio ("vendido por")', () => {
    expect(LABEL_DETECTION_REGEX.test('vendido por: temu official')).toBe(true);
  });

  it('NO matchea una línea sin label conocido (ej: nombre de producto suelto)', () => {
    expect(LABEL_DETECTION_REGEX.test('2 pares de calcetines')).toBe(false);
  });

  it('NO matchea una línea con solo un precio (ej: receipt-style)', () => {
    expect(LABEL_DETECTION_REGEX.test('$1.234,56')).toBe(false);
  });
});
