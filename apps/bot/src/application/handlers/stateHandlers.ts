/**
 * @compras-whatsapp/bot — stateHandlers (special-case state transitions).
 *
 * Extracted from HandleIncomingMessage.ts runStateMachine — handles
 * special-case blocks that bypass the pure state machine:
 * - AGREGANDO_STOCK + SELECCIONAR_PRODUCTO (modo: agregar/editar/eliminar)
 * - EDITANDO_SELECCION + SELECCIONAR_CAMPO (field selection)
 * - EDITANDO_VALOR + VALOR_EDITADO (value update + recalculation)
 * - ELIMINANDO_PRODUCTOS (confirm/reject)
 *
 * Why separate:
 * - These blocks are ~250 lines of inline logic in runStateMachine.
 * - Each block has its own domain logic (recalculation, validation, DB updates).
 * - Now independently testable with mocked HandlerContext.
 *
 * Contract:
 *   handleSpecialCase(params) → Promise<HandlerOutput | null>
 *   Returns null if the current state/event doesn't match any special case.
 */

import { ConversationState } from '@compras-whatsapp/db';

import {
  opcionUnidadSchema,
} from '@compras-whatsapp/shared';

import type { ConversationEvent } from '../../interface/whatsapp/conversationStateMachine.ts';
import type { HandlerContext } from './HandlerContext.ts';

export interface HandlerOutput {
  responses: string[];
  newState: ConversationState;
  rejected: boolean;
}

type SpecialCaseParams = {
  workingState: ConversationState;
  event: ConversationEvent;
  workingDatos: Record<string, unknown>;
  ctx: HandlerContext;
};

/**
 * Handles special-case state transitions that bypass the pure state machine.
 * Returns null if the current state/event doesn't match any special case.
 */
export async function handleSpecialCase(
  params: SpecialCaseParams,
): Promise<HandlerOutput | null> {
  const { workingState, event, workingDatos, ctx } = params;

  // ── AGREGANDO_STOCK (product selected) ──
  if (workingState === ConversationState.AGREGANDO_STOCK && event.type === 'SELECCIONAR_PRODUCTO') {
    return handleAgregarStockSelection(event, workingDatos, ctx, workingState);
  }

  // ── EDITANDO_SELECCION (field selected) ──
  if (workingState === ConversationState.EDITANDO_SELECCION && event.type === 'SELECCIONAR_CAMPO') {
    return handleEditarCampo(event, workingDatos, ctx);
  }

  // ── EDITANDO_VALOR (value entered) ──
  if (workingState === ConversationState.EDITANDO_VALOR && event.type === 'VALOR_EDITADO') {
    return handleEditarValor(event, workingDatos, ctx);
  }

  // ── ELIMINANDO_PRODUCTOS ──
  if (workingState === ConversationState.ELIMINANDO_PRODUCTOS) {
    return handleEliminarConfirmacion(event, workingDatos, ctx);
  }

  return null;
}

// ── Individual handlers ──────────────────────────────────────────────

async function handleAgregarStockSelection(
  event: Extract<ConversationEvent, { type: 'SELECCIONAR_PRODUCTO' }>,
  workingDatos: Record<string, unknown>,
  ctx: HandlerContext,
  workingState: ConversationState,
): Promise<HandlerOutput> {
  const modo = workingDatos['modo'];

  if (modo === 'eliminar') {
    // Show confirmation for single product deletion
    const productos = workingDatos['productosDisponibles'] as Array<{ indice: number; nombre: string }> | undefined;
    const producto = productos?.find((p) => p.indice === event.indice);
    const nombreProducto = producto?.nombre ?? `#${event.indice}`;

    await ctx.conversacionRepo.update(ctx.usuarioId, {
      estado: ConversationState.ELIMINANDO_PRODUCTOS,
      datosTemporales: { ...workingDatos, productoNombre: nombreProducto },
    });
    return {
      responses: [`¿Seguro que querés eliminar "${nombreProducto}" y todos sus registros? (sí/no)`],
      newState: ConversationState.ELIMINANDO_PRODUCTOS,
      rejected: false,
    };
  }

  if (modo === 'editar') {
    // Show edit menu instead of asking for quantity
    const campos = ['1. Nombre', '2. Cantidad', '3. Unidad', '4. Costo lote', '5. Precio venta'];
    const productoIndice = event.indice;
    const productos = workingDatos['productosDisponibles'] as Array<{ indice: number; nombre: string }> | undefined;
    const producto = productos?.find((p) => p.indice === productoIndice);
    const nombreProducto = producto?.nombre ?? `#${productoIndice}`;

    await ctx.conversacionRepo.update(ctx.usuarioId, {
      estado: ConversationState.EDITANDO_SELECCION,
      datosTemporales: { ...workingDatos, productoIndice, productoNombre: nombreProducto },
    });
    return {
      responses: [`Editando "${nombreProducto}". ¿Qué campo querés cambiar?\n${campos.join('\n')}`],
      newState: ConversationState.EDITANDO_SELECCION,
      rejected: false,
    };
  }

  // modo === 'agregar' — store selected product details for cost suggestion, fall through to state machine
  const productos = workingDatos['productosDisponibles'] as Array<{ indice: number; nombre: string; costoLote: number; precioVenta: number; unidad: string }> | undefined;
  const selected = productos?.find((p) => p.indice === event.indice);
  if (selected !== undefined) {
    await ctx.conversacionRepo.update(ctx.usuarioId, {
      estado: workingState,
      datosTemporales: {
        ...workingDatos,
        productoIndice: event.indice,
        producto: selected.nombre,
        unidad: selected.unidad,
      },
    });
  }
  return null;
}

async function handleEditarCampo(
  event: Extract<ConversationEvent, { type: 'SELECCIONAR_CAMPO' }>,
  workingDatos: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<HandlerOutput> {
  const campo = event.campo;
  const productoNombre = workingDatos['productoNombre'] ?? '?';
  const prompts: Record<string, string> = {
    '1': `¿Cuál es el nuevo nombre para "${productoNombre}"?`,
    '2': `¿Cuántas unidades compraste de "${productoNombre}"?`,
    '3': `¿En qué unidad? (unidad/par/pack/caja/otro)`,
    '4': `¿Cuánto te costó el lote de "${productoNombre}"? (precio en pesos)`,
    '5': `¿A cuánto vendés cada una de "${productoNombre}"?`,
  };
  const prompt = prompts[campo];
  if (prompt === undefined) {
    return {
      responses: ['Opción no válida. Elegí un número del 1 al 5.'],
      newState: ConversationState.EDITANDO_SELECCION,
      rejected: true,
    };
  }

  await ctx.conversacionRepo.update(ctx.usuarioId, {
    estado: ConversationState.EDITANDO_VALOR,
    datosTemporales: { ...workingDatos, campoEditando: campo },
  });
  return {
    responses: [prompt],
    newState: ConversationState.EDITANDO_VALOR,
    rejected: false,
  };
}

async function handleEditarValor(
  event: Extract<ConversationEvent, { type: 'VALOR_EDITADO' }>,
  workingDatos: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<HandlerOutput> {
  const campo = workingDatos['campoEditando'] as string;
  const productoIndice = workingDatos['productoIndice'] as number;
  const productoNombre = workingDatos['productoNombre'] as string;
  const productos = workingDatos['productosDisponibles'] as Array<{
    indice: number; nombre: string; costoLote: number; precioVenta: number; unidad: string;
  }>;
  const producto = productos?.find((p) => p.indice === productoIndice);

  if (producto === undefined) {
    return {
      responses: ['No encontré el producto. Empezá de nuevo con /editar.'],
      newState: ConversationState.PREGUNTANDO_PRODUCTO,
      rejected: true,
    };
  }

  // Find the item to update (most recent by name)
  const items = await ctx.itemCompraRepo.findByNombre(producto.nombre);
  if (items.length === 0) {
    return {
      responses: ['No encontré registros de ese producto. Empezá de nuevo con /editar.'],
      newState: ConversationState.PREGUNTANDO_PRODUCTO,
      rejected: true,
    };
  }
  const item = items[0]!; // most recent

  // Build update data based on which field is being edited
  const valor = event.valor;
  const updateData: Record<string, unknown> = {};

  switch (campo) {
    case '1': // Nombre
      updateData['nombre'] = String(valor).toLowerCase();
      break;
    case '2': { // Cantidad
      const cant = Number(valor);
      if (isNaN(cant) || cant <= 0) {
        return {
          responses: ['La cantidad tiene que ser mayor a cero. ¿Cuántas unidades compraste?'],
          newState: ConversationState.EDITANDO_VALOR,
          rejected: true,
        };
      }
      updateData['cantidadLote'] = cant;
      // Recalculate cost unitario
      const costoLote = Number(item.costoLote);
      updateData['costoUnitario'] = (costoLote / cant).toFixed(4);
      // Recalculate ganancia
      const precioVenta = Number(item.precioVenta);
      const costoUnitario = costoLote / cant;
      updateData['gananciaUnitaria'] = (precioVenta - costoUnitario).toFixed(4);
      updateData['gananciaTotal'] = ((precioVenta - costoUnitario) * cant).toFixed(2);
      break;
    }
    case '3': { // Unidad
      const parsed = opcionUnidadSchema.safeParse(String(valor).toLowerCase());
      if (!parsed.success) {
        return {
          responses: ['Unidad no válida. Opciones: unidad, par, pack, caja, otro.'],
          newState: ConversationState.EDITANDO_VALOR,
          rejected: true,
        };
      }
      updateData['unidad'] = parsed.data.toUpperCase();
      break;
    }
    case '4': { // Costo lote
      const costo = Number(valor);
      if (isNaN(costo) || costo <= 0) {
        return {
          responses: ['El costo tiene que ser mayor a cero. ¿Cuánto te costó el lote?'],
          newState: ConversationState.EDITANDO_VALOR,
          rejected: true,
        };
      }
      updateData['costoLote'] = costo.toFixed(2);
      // Recalculate cost unitario
      const cant = Number(item.cantidadLote);
      updateData['costoUnitario'] = (costo / cant).toFixed(4);
      // Recalculate ganancia
      const precioVenta = Number(item.precioVenta);
      updateData['gananciaUnitaria'] = (precioVenta - costo / cant).toFixed(4);
      updateData['gananciaTotal'] = ((precioVenta - costo / cant) * cant).toFixed(2);
      break;
    }
    case '5': { // Precio venta
      const precio = Number(valor);
      if (isNaN(precio) || precio <= 0) {
        return {
          responses: ['El precio tiene que ser mayor a cero. ¿A cuánto vendés cada una?'],
          newState: ConversationState.EDITANDO_VALOR,
          rejected: true,
        };
      }
      updateData['precioVenta'] = precio.toFixed(2);
      // Recalculate ganancia
      const costoUnitario = Number(item.costoUnitario);
      const cant = Number(item.cantidadLote);
      updateData['gananciaUnitaria'] = (precio - costoUnitario).toFixed(4);
      updateData['gananciaTotal'] = ((precio - costoUnitario) * cant).toFixed(2);
      break;
    }
  }

  // Update the item
  await ctx.itemCompraRepo.updateById(item.id, updateData);

  ctx.logger.info(
    { event: 'producto_editado', itemId: item.id, campo, productoNombre },
    'producto actualizado por /editar',
  );

  await ctx.conversacionRepo.update(ctx.usuarioId, {
    estado: ConversationState.PREGUNTANDO_PRODUCTO,
    datosTemporales: {},
  });

  const campoNombres: Record<string, string> = {
    '1': 'nombre', '2': 'cantidad', '3': 'unidad', '4': 'costo lote', '5': 'precio venta',
  };
  return {
    responses: [`✅ Listo, actualicé el campo "${campoNombres[campo]}" de "${productoNombre}".`],
    newState: ConversationState.PREGUNTANDO_PRODUCTO,
    rejected: false,
  };
}

async function handleEliminarConfirmacion(
  event: ConversationEvent,
  workingDatos: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<HandlerOutput> {
  if (event.type === 'USUARIO_CONFIRMA') {
    const productoNombre = workingDatos['productoNombre'] as string;
    const eliminados = await ctx.itemCompraRepo.deleteByNombreAndUsuarioId(productoNombre, ctx.usuarioId);
    ctx.logger.info(
      { event: 'producto_eliminado', usuarioId: ctx.usuarioId, productoNombre, itemsEliminados: eliminados },
      'producto eliminado por /eliminar',
    );
    await ctx.conversacionRepo.update(ctx.usuarioId, {
      estado: ConversationState.PREGUNTANDO_PRODUCTO,
      datosTemporales: {},
    });
    return {
      responses: [`Listo, eliminé "${productoNombre}" (${eliminados} registro${eliminados !== 1 ? 's' : ''}).`],
      newState: ConversationState.PREGUNTANDO_PRODUCTO,
      rejected: false,
    };
  }
  if (event.type === 'USUARIO_RECHAZA') {
    await ctx.conversacionRepo.update(ctx.usuarioId, {
      estado: ConversationState.PREGUNTANDO_PRODUCTO,
      datosTemporales: {},
    });
    return {
      responses: ['Ok, no borro nada.'],
      newState: ConversationState.PREGUNTANDO_PRODUCTO,
      rejected: false,
    };
  }
  return {
    responses: ['Respondé "sí" para eliminar o "no" para cancelar.'],
    newState: ConversationState.ELIMINANDO_PRODUCTOS,
    rejected: true,
  };
}
