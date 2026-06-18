/**
 * Tests unitarios para actionRenderer (pure functions — TDD RED→GREEN→REFACTOR).
 *
 * Verifica que renderAccion genera el texto voseo correcto para cada Accion
 * y que applyAccionToDatos aplica correctamente los side effects.
 */
import { describe, expect, it } from 'vitest';

import { renderAccion, applyAccionToDatos } from '../../../src/application/handlers/actionRenderer.ts';

describe('actionRenderer — renderAccion', () => {
  it('PEDIR_PRODUCTO returns product prompt', () => {
    const result = renderAccion({ tipo: 'PEDIR_PRODUCTO' }, {});
    expect(result).toEqual(['¿Qué producto compraste?']);
  });

  it('PEDIR_CANTIDAD returns quantity prompt', () => {
    const result = renderAccion({ tipo: 'PEDIR_CANTIDAD' }, {});
    expect(result).toEqual(['¿Cuántas unidades compraste?']);
  });

  it('PEDIR_UNIDAD returns unit prompt', () => {
    const result = renderAccion({ tipo: 'PEDIR_UNIDAD' }, {});
    expect(result).toEqual(['¿En qué unidad? (unidad/par/pack/caja/otro)']);
  });

  it('PEDIR_COSTO_LOTE returns cost prompt', () => {
    const result = renderAccion({ tipo: 'PEDIR_COSTO_LOTE' }, {});
    expect(result).toEqual(['¿Cuánto te costó el lote? (precio en pesos)']);
  });

  it('PEDIR_PRECIO_VENTA with quantity and unit includes context', () => {
    const result = renderAccion(
      { tipo: 'PEDIR_PRECIO_VENTA' },
      { cantidadIngresada: 12, unidadIngresada: 'PAR' },
    );
    expect(result[0]).toContain('12');
    expect(result[0]).toContain('par');
    expect(result[0]).toContain('vendés');
  });

  it('PEDIR_PRECIO_VENTA without context returns generic prompt', () => {
    const result = renderAccion({ tipo: 'PEDIR_PRECIO_VENTA' }, {});
    expect(result).toEqual(['¿A cuánto vendés cada una?']);
  });

  it('MOSTRAR_RESUMEN builds summary with metrics', () => {
    const result = renderAccion(
      { tipo: 'MOSTRAR_RESUMEN', resumen: 'ok' },
      { producto: 'medias', cantidadIngresada: 12, unidadIngresada: 'PAR', costoLote: 1200, precioVenta: 1500 },
    );
    expect(result[0]).toContain('12');
    expect(result[0]).toContain('par');
    expect(result[0]).toContain('medias');
    expect(result[0]).toContain('$100'); // costo unitario
    expect(result[0]).toContain('$1500'); // precio venta (uses toFixed, not localeString)
    expect(result[0]).toContain('ganancia');
  });

  it('GUARDAR returns confirmation', () => {
    const result = renderAccion({ tipo: 'GUARDAR' }, {});
    expect(result).toEqual(['¡Listo, guardé la compra!']);
  });

  it('RESET returns custom message', () => {
    const result = renderAccion({ tipo: 'RESET', mensaje: 'Empecemos de nuevo.' }, {});
    expect(result).toEqual(['Empecemos de nuevo.']);
  });

  it('LISTAR_PRODUCTOS with products', () => {
    const result = renderAccion(
      { tipo: 'LISTAR_PRODUCTOS', productos: [{ indice: 1, nombre: 'medias' }, { indice: 2, nombre: 'gorras' }] },
      {},
    );
    expect(result[0]).toContain('1. medias');
    expect(result[0]).toContain('2. gorras');
    expect(result[0]).toContain('Seleccioná');
  });

  it('LISTAR_PRODUCTOS empty returns suggestion', () => {
    const result = renderAccion({ tipo: 'LISTAR_PRODUCTOS', productos: [] }, {});
    expect(result[0]).toContain('No tenés productos');
  });

  it('MOSTRAR_CAMPOS shows field list', () => {
    const result = renderAccion(
      { tipo: 'MOSTRAR_CAMPOS', campos: ['1. Nombre', '2. Cantidad'] },
      {},
    );
    expect(result[0]).toContain('1. Nombre');
    expect(result[0]).toContain('2. Cantidad');
  });

  it('PEDIR_NUEVO_VALOR includes field name', () => {
    const result = renderAccion({ tipo: 'PEDIR_NUEVO_VALOR', campo: 'nombre' }, {});
    expect(result[0]).toContain('nombre');
  });

  it('ACTUALIZAR_PRODUCTO returns success message', () => {
    const result = renderAccion({ tipo: 'ACTUALIZAR_PRODUCTO' }, {});
    expect(result).toEqual(['✅ Producto actualizado.']);
  });

  it('PEDIR_CONFIRMACION_ELIMINAR returns confirmation prompt', () => {
    const result = renderAccion({ tipo: 'PEDIR_CONFIRMACION_ELIMINAR' }, {});
    expect(result[0]).toContain('eliminar');
    expect(result[0]).toContain('sí/no');
  });

  it('CONFIRMADO_ELIMINAR returns success', () => {
    const result = renderAccion({ tipo: 'CONFIRMADO_ELIMINAR' }, {});
    expect(result[0]).toContain('eliminé');
  });

  it('PEDIR_CANTIDAD_VENTA returns sale quantity prompt', () => {
    const result = renderAccion({ tipo: 'PEDIR_CANTIDAD_VENTA' }, {});
    expect(result[0]).toContain('vendés');
  });

  it('MOSTRAR_RESUMEN_VENTA returns summary', () => {
    const result = renderAccion({ tipo: 'MOSTRAR_RESUMEN_VENTA', resumen: 'Vendés 12 a $300' }, {});
    expect(result[0]).toBe('Vendés 12 a $300');
  });

  it('GUARDAR_VENTA returns confirmation', () => {
    const result = renderAccion({ tipo: 'GUARDAR_VENTA' }, {});
    expect(result).toEqual(['¡Listo, guardé la venta!']);
  });

  it('PEDIR_COSTO_LOTE_AGREGAR with product suggestion shows cost hint', () => {
    const result = renderAccion(
      { tipo: 'PEDIR_COSTO_LOTE_AGREGAR' },
      {
        productosDisponibles: [{ indice: 1, nombre: 'medias', costoLote: 1200, precioVenta: 1500 }],
        productoIndice: 1,
      },
    );
    expect(result[0]).toContain('1200');
    expect(result[0]).toContain('costo');
  });

  it('PEDIR_COSTO_LOTE_AGREGAR without product info returns generic prompt', () => {
    const result = renderAccion({ tipo: 'PEDIR_COSTO_LOTE_AGREGAR' }, {});
    expect(result[0]).toContain('costó el lote');
  });
});

describe('actionRenderer — applyAccionToDatos', () => {
  it('RESET returns empty object', () => {
    const result = applyAccionToDatos({ producto: 'medias' }, { tipo: 'RESET', mensaje: 'reset' });
    expect(result).toEqual({});
  });

  it('MOSTRAR_RESUMEN returns datos unchanged', () => {
    const datos = { producto: 'medias', costoLote: 1200 };
    const result = applyAccionToDatos(datos, { tipo: 'MOSTRAR_RESUMEN', resumen: 'ok' });
    expect(result).toBe(datos); // same reference
  });

  it('other actions return datos unchanged', () => {
    const datos = { producto: 'medias' };
    const result = applyAccionToDatos(datos, { tipo: 'PEDIR_CANTIDAD' });
    expect(result).toBe(datos);
  });
});
