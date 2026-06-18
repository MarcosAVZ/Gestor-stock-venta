/**
 * @compras-whatsapp/bot — actionRenderer (pure functions).
 *
 * Extracted from HandleIncomingMessage.ts — renders Accion types to
 * voseo text responses and applies side effects to datosTemporales.
 *
 * Why separate:
 * - Pure functions: no DB, no side effects, trivially testable.
 * - ~100 lines of rendering/switch logic that bloats the orchestrator.
 * - Single responsibility: Accion → text[] and Accion → datos patch.
 */

import type { Accion } from '../../interface/whatsapp/conversationStateMachine.ts';

/** Generates voseo text for each action to send to the user. */
export function renderAccion(
  accion: Accion,
  datos: Record<string, unknown>,
): string[] {
  switch (accion.tipo) {
    case 'PEDIR_PRODUCTO':
      return ['¿Qué producto compraste?'];
    case 'PEDIR_CANTIDAD':
      return ['¿Cuántas unidades compraste?'];
    case 'PEDIR_UNIDAD':
      return ['¿En qué unidad? (unidad/par/pack/caja/otro)'];
    case 'PEDIR_COSTO_LOTE':
      return ['¿Cuánto te costó el lote? (precio en pesos)'];
    case 'PEDIR_COSTO_LOTE_AGREGAR': {
      const productos = datos['productosDisponibles'] as Array<{ indice: number; nombre: string; costoLote: number; precioVenta: number }> | undefined;
      const indice = datos['productoIndice'] as number | undefined;
      const producto = productos?.find((p) => p.indice === indice);
      const suggestions: string[] = [];
      if (producto !== undefined) {
        suggestions.push(`El último costo fue $${producto.costoLote}. ¿Cuánto te costó este lote? (ingresá el nuevo costo)`);
      } else {
        suggestions.push('¿Cuánto te costó el lote? (precio en pesos)');
      }
      return suggestions;
    }
    case 'PEDIR_PRECIO_VENTA': {
      const cant = datos['cantidadIngresada'];
      const unid = datos['unidadIngresada'];
      if (cant !== undefined && unid !== undefined) {
        return [`OK, ${cant} ${String(unid).toLowerCase()}. ¿A cuánto vendés cada una?`];
      }
      return ['¿A cuánto vendés cada una?'];
    }
    case 'MOSTRAR_RESUMEN': {
      const producto = String(datos['producto'] ?? '?');
      const cant = Number(datos['cantidadIngresada'] ?? 0);
      const unid = datos['unidadIngresada'];
      const costoLote = Number(datos['costoLote'] ?? 0);
      const costoU = cant > 0 ? costoLote / cant : 0;
      const precioVenta = datos['precioVenta'] ?? 0;
      const gananciaU = Number(precioVenta) - Number(costoU);
      return [
        `Resumen: ${cant} ${String(unid).toLowerCase()} de ${producto}, ` +
          `costo $${Number(costoU).toFixed(2)} c/u, vendés a $${Number(precioVenta).toFixed(2)}, ` +
          `ganancia $${gananciaU.toFixed(2)} c/u. ¿Guardo? (sí/no)`,
      ];
    }
    case 'GUARDAR':
      return ['¡Listo, guardé la compra!'];
    case 'RESET':
      return [accion.mensaje];
    case 'LISTAR_PRODUCTOS': {
      if (accion.productos.length === 0) {
        return ['No tenés productos cargados. Usá /nueva para empezar.'];
      }
      const lines = accion.productos.map((p) => `${p.indice}. ${p.nombre}`);
      return [`Seleccioná un producto:\n${lines.join('\n')}`];
    }
    case 'MOSTRAR_CAMPOS': {
      return [`¿Qué campo querés cambiar?\n${accion.campos.join('\n')}`];
    }
    case 'PEDIR_NUEVO_VALOR':
      return [`¿Cuál es el nuevo valor para "${accion.campo}"?`];
    case 'ACTUALIZAR_PRODUCTO':
      return ['✅ Producto actualizado.'];
    case 'PEDIR_CONFIRMACION_ELIMINAR':
      return ['¿Seguro que querés eliminar todos tus productos? (sí/no)'];
    case 'CONFIRMADO_ELIMINAR':
      return ['Listo, eliminé todos tus productos.'];
    case 'PEDIR_CANTIDAD_VENTA':
      return ['¿Cuántas unidades vendés?'];
    case 'MOSTRAR_RESUMEN_VENTA': {
      return [accion.resumen || 'Resumen de venta'];
    }
    case 'GUARDAR_VENTA':
      return ['¡Listo, guardé la venta!'];
  }
}

/** Applies the action's side effect to datosTemporales. */
export function applyAccionToDatos(
  datos: Record<string, unknown>,
  accion: Accion,
): Record<string, unknown> {
  switch (accion.tipo) {
    case 'RESET':
      return {};
    case 'MOSTRAR_RESUMEN':
      return datos;
    default:
      return datos;
  }
}
