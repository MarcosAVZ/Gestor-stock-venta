/**
 * @compras-whatsapp/bot — vender handler (slash command dispatch).
 *
 * Handles /vender command — lists products with stock and initiates sale flow.
 *
 * Flow:
 * 1. List products with stock (numbered)
 * 2. User selects → VENDIENDO_SELECCION state
 * 3. Ask quantity → VENDIENDO_CANTIDAD state
 * 4. Validate qty ≤ stock
 * 5. Show "¿Se vende al precio de lista: $X? (sí/no)" → VENDIENDO_CONFIRMACION
 * 6. If "no" → ask custom price
 * 7. Calculate costoUnitario (weighted average)
 * 8. Save Venta
 * 9. Show confirmation with ganancia
 *
 * Contract:
 *   venderHandler(ctx) → Promise<SlashHandlerOutput>
 */

import { ConversationState } from '@compras-whatsapp/db';

import type { HandlerContext } from './HandlerContext.ts';
import type { SlashHandlerOutput } from './slashHandlers.ts';

/**
 * Handles /vender command — lists products with stock.
 * Returns the handler output (responses + new state).
 */
export async function handleVender(ctx: HandlerContext): Promise<SlashHandlerOutput> {
  const { listarProductosConStock } = await import('../conversation/Vender.ts');
  const productos = await listarProductosConStock(ctx.usuarioId, { prisma: ctx.prisma, ventaRepo: ctx.ventaRepo as any });

  if (productos.length === 0) {
    return {
      responses: ['No tenés productos con stock para vender.'],
      newState: ctx.workingState,
      rejected: false,
    };
  }

  const lines = productos.map((p) => `${p.indice}. ${p.nombre} (stock: ${p.stock})`);
  const lista = `Seleccioná el producto que querés vender:\n${lines.join('\n')}`;

  await ctx.conversacionRepo.update(ctx.usuarioId, {
    estado: ConversationState.VENDIENDO_SELECCION,
    datosTemporales: { productosDisponibles: productos },
  });

  return {
    responses: [lista],
    newState: ConversationState.VENDIENDO_SELECCION,
    rejected: false,
  };
}
