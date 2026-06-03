/**
 * Tests del parser heurístico de OCR.
 *
 * Casos cubiertos:
 * - Precio AR style con miles y decimal: `$1.234,56`
 * - Precio US style: `$1,234.56`
 * - Prefijos de moneda: `AR$`, `ARS`, `$`
 * - Sin prefijo: `1234,50`
 * - Sin separador: `$1234`
 * - Cantidad + unidad: `2 unidades`, `3 packs`, `1 par`
 * - Leading qty: `2x Producto`
 * - Múltiples precios en una línea (combos)
 * - Múltiples líneas (varios productos)
 * - Texto sin precios → productos: []
 * - Sin nombre (solo precio) → descartar
 * - Truncar nombre a 60 chars
 * - Cap de MAX_PRODUCTOS
 */

import { describe, expect, it } from 'vitest';

import type { OCRResult } from '@compras-whatsapp/shared';
import { EMPTY_OCR_RESULT } from '@compras-whatsapp/shared';

import {
  classifyLine,
  defaultUnitForName,
  parseOCRText,
} from '../../src/infrastructure/ocr/ocrParser.ts';

/** Helper: crea un OCRResult con texto + tiempo/confianza arbitrarios. */
function makeRaw(text: string): OCRResult {
  return { ...EMPTY_OCR_RESULT, textoCompleto: text, tiempoMs: 100, confianzaPromedio: 0.85 };
}

describe('ocrParser.parseOCRText', () => {
  describe('precios', () => {
    it('parsea precio AR style con miles y decimal', () => {
      const r = parseOCRText(makeRaw('Remera Negra\n$1.234,56'));
      expect(r.productos).toHaveLength(1);
      expect(r.productos[0]!.precio).toBe(1234.56);
      expect(r.productos[0]!.nombre).toBe('Remera Negra');
    });

    it('parsea precio US style con coma miles y punto decimal', () => {
      const r = parseOCRText(makeRaw('Pantalón\n$1,234.56'));
      expect(r.productos[0]!.precio).toBe(1234.56);
    });

    it('parsea precio con prefijo AR$', () => {
      const r = parseOCRText(makeRaw('Zapatilla\nAR$ 1234.56'));
      expect(r.productos[0]!.precio).toBe(1234.56);
    });

    it('parsea precio con prefijo ARS', () => {
      const r = parseOCRText(makeRaw('Campera\nARS 1.234,56'));
      expect(r.productos[0]!.precio).toBe(1234.56);
    });

    it('parsea precio sin prefijo', () => {
      const r = parseOCRText(makeRaw('Medias\n1234,50'));
      expect(r.productos[0]!.precio).toBe(1234.5);
    });

    it('parsea precio entero sin decimales', () => {
      const r = parseOCRText(makeRaw('Gorra\n$1234'));
      expect(r.productos[0]!.precio).toBe(1234);
    });

    it('parsea precio con un solo decimal', () => {
      const r = parseOCRText(makeRaw('Bufanda\n$99,5'));
      expect(r.productos[0]!.precio).toBe(99.5);
    });

    it('descarta token con decimal > 2 dígitos (no es decimal)', () => {
      // `1,234` no puede ser decimal (3 dígitos), se trata como miles
      const r = parseOCRText(makeRaw('Item\n$1,234'));
      expect(r.productos[0]!.precio).toBe(1234);
    });
  });

  describe('cantidad + unidad', () => {
    it('parsea cantidad con "unidades"', () => {
      const r = parseOCRText(makeRaw('Lapicera\n$500\n2 unidades'));
      expect(r.productos[0]!.cantidad).toBe(2);
      expect(r.productos[0]!.unidad).toBe('UNIDAD');
    });

    it('parsea cantidad con "packs"', () => {
      const r = parseOCRText(makeRaw('Pack medias\n$2000\n3 packs'));
      expect(r.productos[0]!.cantidad).toBe(3);
      expect(r.productos[0]!.unidad).toBe('PACK');
    });

    it('parsea cantidad con "pares"', () => {
      const r = parseOCRText(makeRaw('Zapatos\n$5000\n1 par'));
      expect(r.productos[0]!.cantidad).toBe(1);
      expect(r.productos[0]!.unidad).toBe('PAR');
    });

    it('parsea cantidad con "cajas"', () => {
      const r = parseOCRText(makeRaw('Resma\n$3000\n2 cajas'));
      expect(r.productos[0]!.cantidad).toBe(2);
      expect(r.productos[0]!.unidad).toBe('CAJA');
    });

    it('default 1 si no hay cantidad', () => {
      const r = parseOCRText(makeRaw('Cuaderno\n$500'));
      expect(r.productos[0]!.cantidad).toBe(1);
      expect(r.productos[0]!.unidad).toBe('UNIDAD');
    });

    it('parsea leading quantity "2x Producto"', () => {
      const r = parseOCRText(makeRaw('2x Remera\n$1500'));
      expect(r.productos[0]!.cantidad).toBe(2);
      expect(r.productos[0]!.nombre).toBe('Remera');
    });
  });

  describe('multi-producto', () => {
    it('parsea múltiples líneas con un producto cada una', () => {
      const text = `Remera Negra $1.234,56
Pantalón Jean $2.500,00
Zapatillas $5.999,99`;
      const r = parseOCRText(makeRaw(text));
      expect(r.productos).toHaveLength(3);
      expect(r.productos[0]!.nombre).toBe('Remera Negra');
      expect(r.productos[0]!.precio).toBe(1234.56);
      expect(r.productos[1]!.nombre).toBe('Pantalón Jean');
      expect(r.productos[1]!.precio).toBe(2500);
      expect(r.productos[2]!.nombre).toBe('Zapatillas');
      expect(r.productos[2]!.precio).toBe(5999.99);
    });

    it('parsea múltiples precios en una línea (combo)', () => {
      const r = parseOCRText(makeRaw('Combo: remera $1000 + shorts $800'));
      expect(r.productos.length).toBeGreaterThanOrEqual(1);
      // Al menos uno de los precios detectados
      const precios = r.productos.map((p) => p.precio);
      expect(precios).toContain(1000);
    });

    it('cap de MAX_PRODUCTOS (10)', () => {
      const lines = Array.from({ length: 20 }, (_, i) => `Item ${i}\n$100`).join('\n');
      const r = parseOCRText(makeRaw(lines));
      expect(r.productos.length).toBeLessThanOrEqual(10);
    });
  });

  describe('edge cases', () => {
    it('devuelve productos vacío si no hay precios', () => {
      const r = parseOCRText(makeRaw('Solo texto sin números'));
      expect(r.productos).toEqual([]);
    });

    it('descarta línea sin nombre (solo precio)', () => {
      const r = parseOCRText(makeRaw('$500'));
      expect(r.productos).toEqual([]);
    });

    it('preserva textoCompleto, tiempoMs y confianzaPromedio', () => {
      const raw: OCRResult = {
        textoCompleto: 'Remera\n$1500',
        tiempoMs: 250,
        confianzaPromedio: 0.92,
        productos: [],
      };
      const r = parseOCRText(raw);
      expect(r.textoCompleto).toBe('Remera\n$1500');
      expect(r.tiempoMs).toBe(250);
      expect(r.confianzaPromedio).toBe(0.92);
    });

    it('maneja texto vacío', () => {
      const r = parseOCRText(makeRaw(''));
      expect(r.productos).toEqual([]);
    });

    it('ignora líneas vacías entre productos', () => {
      const text = `Remera $1500

Pantalón $2500`;
      const r = parseOCRText(makeRaw(text));
      expect(r.productos).toHaveLength(2);
    });

    it('trunca nombre a 60 chars', () => {
      const longName = 'A'.repeat(80);
      const r = parseOCRText(makeRaw(`${longName}\n$100`));
      expect(r.productos[0]!.nombre.length).toBeLessThanOrEqual(60);
    });

    it('tolera CRLF en el texto (Windows OCR)', () => {
      const r = parseOCRText(makeRaw('Remera\r\n$1500\r\nPantalón\r\n$2500'));
      expect(r.productos).toHaveLength(2);
    });

    it('no emite producto si el precio es 0 o negativo', () => {
      const r = parseOCRText(makeRaw('Gratis\n$0'));
      expect(r.productos).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // e-commerce screenshots (cambio ocr-parser-label-aware / WU3).
  // ─────────────────────────────────────────────────────────────────────

  describe('e-commerce: Temu screenshot (label-aware path)', () => {
    it('Temu screenshot: parses 1 product with LOTE unit and correct price', () => {
      // Fixture plausible: Tesseract output de la captura Temu del
      // proposal §1. Noise + labeled structure. El parser label-aware
      // debe emitir EXACTAMENTE 1 producto (no 5+ phantom), con el
      // precio ACTUAL (33.928), no el ANTERIOR (53.385), y con
      // unidad LOTE porque el título contiene lot-multiplier.
      const temuText = [
        'Tienda: ZJ-SHIRUI',
        'Seguidores: 1.2K',
        'Artículos: 24',
        '2 pares de calcetines',
        'Variante: 10 pares de gatos grises + 10 pares de modelo B',
        'Precio del lote: ARS$33.928',
        'Precio anterior: ARS$53.385',
        'Cantidad comprada: x1',
      ].join('\n');

      const r = parseOCRText(makeRaw(temuText));

      // Solo el producto real — NOISE + PRICE_OLD deben descartarse.
      expect(r.productos).toHaveLength(1);
      const p = r.productos[0]!;
      // Nombre incluye "calcetines" (substring, case-insensitive).
      expect(p.nombre.toLowerCase()).toContain('calcetines');
      // Precio actual, NO el anterior tachado.
      expect(p.precio).toBe(33928);
      // Cantidad del x1 explícito.
      expect(p.cantidad).toBe(1);
      // Unidad LOTE (heurística: "pares" en el título).
      expect(p.unidad).toBe('LOTE');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // T3.2 — `classifyLine` (line classifier del label-aware path).
  // ─────────────────────────────────────────────────────────────────────

  describe('ocrParser.classifyLine (line classifier)', () => {
    it('classifies a PRICE_CURRENT line and emits the value as a number', () => {
      const c = classifyLine('Precio del lote: $33.928');
      expect(c.label).toBe('PRICE_CURRENT');
      expect(c.value).toBe(33928);
      expect(c.raw).toBe('Precio del lote: $33.928');
    });

    it('classifies a NOISE line and emits value: null', () => {
      const c = classifyLine('Tienda: ZJ-SHIRUI');
      expect(c.label).toBe('NOISE');
      expect(c.value).toBeNull();
    });

    it('classifies a QUANTITY line in xN form and emits { cantidad, unidad }', () => {
      const c = classifyLine('Cantidad comprada: x1');
      expect(c.label).toBe('QUANTITY');
      expect(c.value).toEqual({ cantidad: 1, unidad: 'UNIDAD' });
    });

    it('classifies a PRICE_OLD line and emits the value as a number', () => {
      // El classifier SOLO etiqueta — la desambiguación current/old
      // ocurre en el aggregator. Aquí validamos que Precio anterior
      // matchea PRICE_OLD y extrae el número 53385.
      const c = classifyLine('Precio anterior: ARS$53.385');
      expect(c.label).toBe('PRICE_OLD');
      expect(c.value).toBe(53385);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // T3.4 — `defaultUnitForName` (lot-multiplier heuristic).
  // ─────────────────────────────────────────────────────────────────────

  describe('ocrParser.defaultUnitForName (lot-multiplier heuristic)', () => {
    it('returns LOTE for a name with a digit + plural unit phrase (e.g., "2 pares de …")', () => {
      expect(defaultUnitForName('2 pares de calcetines')).toBe('LOTE');
    });

    it('returns LOTE for a name with a lot-multiplier word (e.g., "Pack 3 remeras")', () => {
      expect(defaultUnitForName('Pack 3 remeras')).toBe('LOTE');
    });

    it('returns UNIDAD for a plain name with no lot-multiplier signal', () => {
      expect(defaultUnitForName('Remera Negra')).toBe('UNIDAD');
    });
  });
});
