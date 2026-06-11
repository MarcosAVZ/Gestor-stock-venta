# OCR Parser Specification

## Purpose

Define the behavior of `parseOCRText` — the heuristic that converts raw OCR
text into a list of `OCRProduct` records. The parser handles two document
shapes:

- **Receipts**: one product per line, no labels (legacy shape, preserved).
- **E-commerce screenshots**: screen-oriented with labeled fields like
  `Precio:`, `Cantidad:`, `Tienda:`, `Vendedor:`, `Precio del lote:`,
  `Precio anterior:`.

This spec is a DELTA over the pre-`ocr-parser-label-aware` parser. Existing
receipt-shape behavior is preserved verbatim through a label-detection fallback.
New label-aware behavior handles the labeled e-commerce shape.

## MODIFIED Requirements

### Requirement: Line-by-line parsing preserved as fallback
The system MUST run the existing line-by-line parser unchanged when the
input text contains zero recognized labels. Receipt-style OCR MUST keep
producing byte-for-byte the same output as before this change.

(Previously: the parser was a single line-by-line aggregator with no
label concept. Receipt behavior is preserved verbatim via fallback.)

#### Scenario: Pure receipt text with no labels falls back unchanged
- GIVEN text `Remera Negra\n$1.234,56` (zero labels detected)
- WHEN `parseOCRText` is called
- THEN `productos.length === 1`
- AND `productos[0].nombre === "Remera Negra"`
- AND `productos[0].precio === 1234.56`
- AND `productos[0].cantidad === 1`
- AND `productos[0].unidad === "UNIDAD"`

#### Scenario: All existing receipt tests pass byte-for-byte
- GIVEN the existing `ocrParser.test.ts` fixture suite (AR/US price styles, leading qty, cap of 10, multi-product, CRLF, empty text, name truncation)
- WHEN the test suite is executed
- THEN every existing test case passes with the same numeric values as before the change

### Requirement: Label-aware line classification
The system MUST detect Spanish labels at the start of any non-empty line
(case-insensitive, accent-tolerant, with or without trailing `:` / `–` / `-`),
classify the line as one of `NOISE`, `PRICE_CURRENT`, `PRICE_OLD`, `QUANTITY`,
`NAME_CANDIDATE`, `LOTE_CONTENT` (reserved for future), or `UNKNOWN`, and
emit no product from a `NOISE` line. When at least one label is detected in
the document, the labeled path is used; otherwise the fallback applies.

(Previously: no concept of labels existed; every non-empty line was a
candidate name or product.)

#### Scenario: A line with a NOISE label emits no product
- GIVEN a line `Tienda: ZJ-SHIRUI` (or any of: `Vendedor`, `Vendido por`, `Seguidores`, `Artículos`, `Productos de la tienda`, `Calificación`, `Valoración`, `Reseñas`, `Envío`, `Envío gratis`, `Stock`, `Disponibilidad`, `Categoría`, `Marca`, `Color`, `Talla`)
- WHEN `parseOCRText` is called with a document containing this line
- THEN the line contributes zero products to `productos`

#### Scenario: A line with a PRICE_CURRENT label contributes a price candidate with HIGH priority
- GIVEN a line `Precio del lote: ARS$33.928` (or any of: `Precio actual`, `Precio`, `Precio total`, `Total`, `Subtotal`, `Ahora`, `Precio ahora`, `Importe`)
- WHEN `parseOCRText` is called
- THEN a price candidate with value 33928 and priority HIGH is registered

#### Scenario: A line with a PRICE_OLD label contributes a price candidate with LOW priority
- GIVEN a line `Precio anterior: ARS$53.385` (or any of: `Antes`, `Precio tachado`, `Precio original`, `Precio recomendado`)
- WHEN `parseOCRText` is called
- THEN a price candidate with value 53385 and priority LOW is registered

#### Scenario: A line with a QUANTITY label or trailing "xN" contributes a cantidad
- GIVEN a line `Cantidad comprada: x1` (or any of: `Cantidad`, `Unidades`, `Pares`) OR a line ending in `x 2`, `X 3`, `x 5`
- WHEN `parseOCRText` is called
- THEN the numeric portion is extracted as the `cantidad` of the current product

### Requirement: Price disambiguation when multiple price candidates exist
The system MUST pick the correct `precio` when multiple price candidates
appear in the document.

(Previously: the parser emitted one product per detected price token, with
no notion of which price was "current" vs "old".)

#### Scenario: Both PRICE_CURRENT and PRICE_OLD labels — current wins
- GIVEN a document containing both `Precio del lote: 33928` and `Precio anterior: 53385`
- WHEN `parseOCRText` is called
- THEN the resulting product has `precio === 33928` (the labeled current price, NOT the old)

#### Scenario: A PRICE_CURRENT label always wins over PRICE_OLD regardless of value
- GIVEN a document where `Precio actual: 100` and `Precio anterior: 9999` appear
- WHEN `parseOCRText` is called
- THEN the resulting product has `precio === 100`

#### Scenario: Two adjacent prices with no labels — lower value wins (legacy fallback)
- GIVEN a document `Antes: $100 / Ahora: $80` (no labeled line, only inline)
- WHEN `parseOCRText` is called
- THEN the resulting product has `precio === 80` (the lower of the two adjacent values)

### Requirement: Quantity parsing for "xN" forms
The system MUST parse `x1`, `X 2`, `x 3` (case-insensitive, with or without
space after `x`) as a `cantidad`.

(Previously: the parser handled "2x Producto" leading quantity only.)

#### Scenario: A line ending with "x N" produces cantidad = N
- GIVEN a line `2 pares de calcetines x 1`
- WHEN `parseOCRText` is called
- THEN `cantidad === 1`

#### Scenario: "Cantidad: x N" produces cantidad = N
- GIVEN a line `Cantidad: x1`
- WHEN `parseOCRText` is called
- THEN `cantidad === 1`

#### Scenario: "X 2" with uppercase X also parses case-insensitively
- GIVEN a line `Cantidad: X 2` (or trailing `X 3`)
- WHEN `parseOCRText` is called
- THEN the quantity equals the trailing digit

### Requirement: Unit defaulting when no explicit unit word is parsed
When the only quantity signal is `x1` (or another bare number with no
unit word) and no unit has been determined, the system MUST default the
unit to `LOTE` if the product title contains a lot-multiplier word
(`pack`, `lote`, `set`, `juego`, `combo`, or a `\d+ (pares|unidades|packs|cajas)`
substring), otherwise to `UNIDAD`.

(Previously: bare numbers defaulted to `UNIDAD` always.)

#### Scenario: Title with lot-multiplier word yields unidad = LOTE
- GIVEN a document where the product title contains `pack` (or `lote`/`set`/`juego`/`combo`, or `2 pares`/`10 unidades`) and the only qty signal is `x1`
- WHEN `parseOCRText` is called
- THEN the emitted product has `unidad === "LOTE"`

#### Scenario: Title without lot-multiplier word yields unidad = UNIDAD
- GIVEN a document where the product title does NOT contain any lot-multiplier word and the only qty signal is `x1`
- WHEN `parseOCRText` is called
- THEN the emitted product has `unidad === "UNIDAD"`

### Requirement: Maximum product cap of 10
The system MUST emit at most 10 products per OCR document, in document order.

(Previously: the cap was applied to the line-by-line aggregator; it is
preserved for the label-aware path too.)

#### Scenario: More than 10 candidate products — only 10 emitted in document order
- GIVEN a document that the parser would resolve to 20 products
- WHEN `parseOCRText` is called
- THEN `productos.length <= 10`
- AND the first 10 in document order are kept

### Requirement: Empty product list on garbage input
The system MUST return `productos: []` without throwing when the input has
no recognizable products (random noise, no prices, no labels).

(Previously: garbage input returned `productos: []`; preserved.)

#### Scenario: Random noise text yields empty array, no throw
- GIVEN a document consisting of random characters with no labels and no prices
- WHEN `parseOCRText` is called
- THEN `productos` is an empty array
- AND no exception is thrown

## ADDED Requirements

### Requirement: Inline "Antes: $X / Ahora: $Y" form on a single line
The system MUST recognize the inline form where a single line contains both
`Antes: $X` and `Ahora: $Y` (or `Precio anterior: $X` / `Precio actual: $Y`
inline), and treat the `Ahora` / current value as the `precio`.

#### Scenario: Inline before/after on one line — Ahora wins
- GIVEN a line `Antes: $100  Ahora: $80`
- WHEN `parseOCRText` is called
- THEN the resulting product has `precio === 80`

### Requirement: "LOTE" as a valid emitted unidad
The parser MUST be able to emit `unidad: "LOTE"` for products where the
title implies a pack and the quantity signal is `x1`.

#### Scenario: Temu case emits exactly 1 product with LOTE unit and correct price
- GIVEN a Temu-shape document containing `Tienda: ZJ-SHIRUI`, `Seguidores: 1.2K`, `Artículos: 24`, a product title containing "calcetines" plus a lot-multiplier word, `Precio del lote: ARS$33.928`, `Precio anterior: ARS$53.385`, `Cantidad comprada: x1`
- WHEN `parseOCRText` is called
- THEN `productos.length === 1`
- AND `productos[0].precio === 33928`
- AND `productos[0].cantidad === 1`
- AND `productos[0].unidad === "LOTE"`
- AND `productos[0].nombre` contains "calcetines"

### Requirement: NOISE label dictionary is fixed and exhaustive for v0
The system MUST recognize a fixed closed set of NOISE labels (Tienda,
Vendedor, Vendido por, Seguidores, Artículos, Productos de la tienda,
Calificación, Valoración, Reseñas, Envío, Envío gratis, Stock,
Disponibilidad, Categoría, Marca, Color, Talla) and skip the entire line.
The taxonomy grows organically in future changes; no new label is added
in this cycle.

#### Scenario: Each NOISE label in the fixed dictionary is skipped
- GIVEN a document containing any line starting with one of the NOISE labels above
- WHEN `parseOCRText` is called
- THEN that line contributes zero products
- AND the line does not pollute the pending name pool

### Requirement: MercadoLibre and Shein labeled fixtures parse to one product
The system MUST produce exactly one product for labeled MercadoLibre-shape
and Shein-shape fixtures, with the labeled current price and the labeled
quantity (or the lot-multiplier default).

#### Scenario: MercadoLibre labeled structure
- GIVEN a document with `Vendedor: TiendaX`, `Precio: 1234,56`, `Cantidad: 2`
- WHEN `parseOCRText` is called
- THEN exactly 1 product is emitted
- AND `precio === 1234.56`
- AND `cantidad === 2`

#### Scenario: Shein labeled structure with lot price
- GIVEN a document with `Precio del lote: 5000`, `Precio anterior: 8000`, and a title containing a lot-multiplier word
- WHEN `parseOCRText` is called
- THEN exactly 1 product is emitted
- AND `precio === 5000`
- AND `unidad === "LOTE"`

## REMOVED Requirements

None. All existing parser behavior is preserved via the fallback path.
