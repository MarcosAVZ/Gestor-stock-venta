/**
 * Tests de los schemas Zod de `@compras-whatsapp/shared`.
 *
 * Cubre:
 * - `cantidadSchema`: entero positivo, tope 10000.
 * - `precioSchema`: número directo, strings ARS en distintos formatos.
 * - `parsePrecioString`: tabla de formatos AR/US.
 * - `opcionUnidadSchema`: todas las variantes + inputs inválidos.
 * - `opcionSiNoSchema`: variantes sí/no + inválidos.
 */
import { describe, expect, it } from 'vitest';

import {
  cantidadSchema,
  opcionSiNoSchema,
  opcionUnidadSchema,
  parsePrecioString,
  precioSchema,
} from '../src/schemas/index.ts';
import { Unidad } from '../src/enums/Unidad.ts';

describe('cantidadSchema', () => {
  it('acepta enteros positivos', () => {
    expect(cantidadSchema.parse(1)).toBe(1);
    expect(cantidadSchema.parse(12)).toBe(12);
    expect(cantidadSchema.parse(10000)).toBe(10000);
  });

  it('rechaza cero', () => {
    const r = cantidadSchema.safeParse(0);
    expect(r.success).toBe(false);
  });

  it('rechaza negativos', () => {
    expect(cantidadSchema.safeParse(-1).success).toBe(false);
    expect(cantidadSchema.safeParse(-100).success).toBe(false);
  });

  it('rechaza no enteros', () => {
    expect(cantidadSchema.safeParse(1.5).success).toBe(false);
    expect(cantidadSchema.safeParse(12.99).success).toBe(false);
  });

  it('rechaza por encima del tope', () => {
    expect(cantidadSchema.safeParse(10001).success).toBe(false);
    expect(cantidadSchema.safeParse(999999).success).toBe(false);
  });
});

describe('precioSchema', () => {
  it('acepta números positivos', () => {
    expect(precioSchema.parse(1500)).toBe(1500);
    expect(precioSchema.parse(0.01)).toBe(0.01);
  });

  it('acepta strings numéricos simples', () => {
    expect(precioSchema.parse('1500')).toBe(1500);
    expect(precioSchema.parse('6000')).toBe(6000);
  });

  it('acepta strings con símbolo de moneda', () => {
    expect(precioSchema.parse('$1500')).toBe(1500);
    expect(precioSchema.parse('AR$ 1500')).toBe(1500);
    expect(precioSchema.parse('ARS 1500')).toBe(1500);
  });

  it('parsea separador de miles es-AR (1.500 → 1500)', () => {
    expect(precioSchema.parse('1.500')).toBe(1500);
    expect(precioSchema.parse('$1.500')).toBe(1500);
    expect(precioSchema.parse('1.500.000')).toBe(1_500_000);
  });

  it('parsea separador de miles US (1,500 → 1500)', () => {
    expect(precioSchema.parse('1,500')).toBe(1500);
    expect(precioSchema.parse('1,500,000')).toBe(1_500_000);
  });

  it('parsea decimal es-AR (1.500,50 → 1500.5)', () => {
    expect(precioSchema.parse('1.500,50')).toBe(1500.5);
  });

  it('parsea decimal US (1,500.50 → 1500.5)', () => {
    expect(precioSchema.parse('1,500.50')).toBe(1500.5);
  });

  it('parsea decimal simple (1,5 → 1.5)', () => {
    expect(precioSchema.parse('1,5')).toBe(1.5);
  });

  it('rechaza precio 0', () => {
    expect(precioSchema.safeParse(0).success).toBe(false);
    expect(precioSchema.safeParse('0').success).toBe(false);
  });

  it('rechaza precios negativos', () => {
    expect(precioSchema.safeParse(-100).success).toBe(false);
    expect(precioSchema.safeParse('-100').success).toBe(false);
  });

  it('rechaza por encima del tope', () => {
    expect(precioSchema.safeParse(20_000_000).success).toBe(false);
    expect(precioSchema.safeParse('999999999').success).toBe(false);
  });

  it('rechaza strings no numéricos', () => {
    expect(precioSchema.safeParse('abc').success).toBe(false);
    expect(precioSchema.safeParse('').success).toBe(false);
  });
});

describe('parsePrecioString', () => {
  it('caso 1000 → 1000', () => {
    expect(parsePrecioString('1000')).toBe(1000);
  });

  it('caso $1.500 → 1500', () => {
    expect(parsePrecioString('$1.500')).toBe(1500);
  });

  it('caso 6.000 → 6000', () => {
    expect(parsePrecioString('6.000')).toBe(6000);
  });

  it('caso 1.500,50 → 1500.5', () => {
    expect(parsePrecioString('1.500,50')).toBe(1500.5);
  });

  it('caso 1500.5 → 1500.5 (decimal US)', () => {
    expect(parsePrecioString('1500.5')).toBe(1500.5);
  });

  it('caso AR$ 1.234.567,89 → 1234567.89', () => {
    expect(parsePrecioString('AR$ 1.234.567,89')).toBe(1234567.89);
  });
});

describe('opcionUnidadSchema', () => {
  it('normaliza todas las variantes de UNIDAD', () => {
    expect(opcionUnidadSchema.parse('unidad')).toBe(Unidad.UNIDAD);
    expect(opcionUnidadSchema.parse('UNIDAD')).toBe(Unidad.UNIDAD);
    expect(opcionUnidadSchema.parse('Unidad')).toBe(Unidad.UNIDAD);
    expect(opcionUnidadSchema.parse('unidades')).toBe(Unidad.UNIDAD);
    expect(opcionUnidadSchema.parse('u')).toBe(Unidad.UNIDAD);
  });

  it('normaliza PAR', () => {
    expect(opcionUnidadSchema.parse('par')).toBe(Unidad.PAR);
    expect(opcionUnidadSchema.parse('pares')).toBe(Unidad.PAR);
  });

  it('normaliza PACK', () => {
    expect(opcionUnidadSchema.parse('pack')).toBe(Unidad.PACK);
    expect(opcionUnidadSchema.parse('packs')).toBe(Unidad.PACK);
  });

  it('normaliza CAJA', () => {
    expect(opcionUnidadSchema.parse('caja')).toBe(Unidad.CAJA);
    expect(opcionUnidadSchema.parse('cajas')).toBe(Unidad.CAJA);
  });

  it('normaliza OTRO', () => {
    expect(opcionUnidadSchema.parse('otro')).toBe(Unidad.OTRO);
    expect(opcionUnidadSchema.parse('otra')).toBe(Unidad.OTRO);
  });

  it('rechaza unidades inválidas', () => {
    expect(opcionUnidadSchema.safeParse('kilo').success).toBe(false);
    expect(opcionUnidadSchema.safeParse('docena').success).toBe(false);
    expect(opcionUnidadSchema.safeParse('').success).toBe(false);
  });

  it('tolera espacios extras', () => {
    expect(opcionUnidadSchema.parse('  par  ')).toBe(Unidad.PAR);
  });
});

describe('opcionSiNoSchema', () => {
  it('acepta variantes de sí', () => {
    expect(opcionSiNoSchema.parse('si')).toBe('si');
    expect(opcionSiNoSchema.parse('sí')).toBe('si');
    expect(opcionSiNoSchema.parse('SI')).toBe('si');
    expect(opcionSiNoSchema.parse('s')).toBe('si');
    expect(opcionSiNoSchema.parse('yes')).toBe('si');
    expect(opcionSiNoSchema.parse('y')).toBe('si');
    expect(opcionSiNoSchema.parse('ok')).toBe('si');
    expect(opcionSiNoSchema.parse('dale')).toBe('si');
    expect(opcionSiNoSchema.parse('1')).toBe('si');
  });

  it('acepta variantes de no', () => {
    expect(opcionSiNoSchema.parse('no')).toBe('no');
    expect(opcionSiNoSchema.parse('NO')).toBe('no');
    expect(opcionSiNoSchema.parse('n')).toBe('no');
    expect(opcionSiNoSchema.parse('mal')).toBe('no');
    expect(opcionSiNoSchema.parse('incorrecto')).toBe('no');
    expect(opcionSiNoSchema.parse('2')).toBe('no');
  });

  it('rechaza respuestas ambiguas', () => {
    expect(opcionSiNoSchema.safeParse('quizas').success).toBe(false);
    expect(opcionSiNoSchema.safeParse('').success).toBe(false);
    expect(opcionSiNoSchema.safeParse('3').success).toBe(false);
  });
});
