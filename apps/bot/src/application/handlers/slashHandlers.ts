/**
 * @compras-whatsapp/bot — slashHandlers (slash command dispatch).
 *
 * Extracted from HandleIncomingMessage.ts — handles /nueva, /agregar,
 * /editar, /eliminar, /ayuda slash commands.
 *
 * Why separate:
 * - Each slash command is an independent handler (~20-40 lines each).
 * - The switch block was ~100 lines inline in handleSlashCommand.
 * - Now each command is independently testable with a mock HandlerContext.
 *
 * Contract:
 *   slashHandler(cmd, ctx) → Promise<HandleIncomingMessageOutput>
 *
 * Where HandleIncomingMessageOutput = { responses: string[], newState, rejected }
 */

import { ConversationState } from '@compras-whatsapp/db';

import type { BotCommand } from '../commands/parseCommand.ts';
import type { HandlerContext } from './HandlerContext.ts';
import { HELP_TEXT } from '../queries/index.ts';

export interface SlashHandlerOutput {
  responses: string[];
  newState: ConversationState;
  rejected: boolean;
}

/**
 * Dispatches a slash command to the appropriate handler.
 * Returns the handler output (responses + new state).
 */
export async function handleSlashCommand(
  cmd: BotCommand,
  ctx: HandlerContext,
): Promise<SlashHandlerOutput> {
  switch (cmd.type) {
    case 'nueva':
      return nuevaHandler(ctx);
    case 'agregar':
      return agregarHandler(ctx);
    case 'editar':
      return editarHandler(ctx);
    case 'eliminar':
      return eliminarHandler(ctx);
    case 'ayuda':
      return ayudaHandler(ctx);
    case 'vender':
      return venderHandler(ctx);
    case 'exportar':
      return exportarHandler(ctx);
  }
}

// ── Individual handlers ──────────────────────────────────────────────

async function nuevaHandler(ctx: HandlerContext): Promise<SlashHandlerOutput> {
  await ctx.conversacionRepo.update(ctx.usuarioId, {
    estado: ConversationState.PREGUNTANDO_PRODUCTO,
    datosTemporales: {},
  });
  return {
    responses: ['¿Qué producto compraste?'],
    newState: ConversationState.PREGUNTANDO_PRODUCTO,
    rejected: false,
  };
}

async function agregarHandler(ctx: HandlerContext): Promise<SlashHandlerOutput> {
  const { listarProductos } = await import('../conversation/AgregarStock.ts');
  const productos = await listarProductos(ctx.usuarioId, { prisma: ctx.prisma });
  if (productos.length === 0) {
    return {
      responses: ['No tenés productos cargados. Usá /nueva para empezar.'],
      newState: ctx.workingState,
      rejected: false,
    };
  }
  const lines = productos.map((p) => `${p.indice}. ${p.nombre}`);
  const lista = `Seleccioná un producto:\n${lines.join('\n')}`;
  await ctx.conversacionRepo.update(ctx.usuarioId, {
    estado: ConversationState.AGREGANDO_STOCK,
    datosTemporales: { productosDisponibles: productos, modo: 'agregar' },
  });
  return {
    responses: [lista],
    newState: ConversationState.AGREGANDO_STOCK,
    rejected: false,
  };
}

async function editarHandler(ctx: HandlerContext): Promise<SlashHandlerOutput> {
  const { listarProductos } = await import('../conversation/AgregarStock.ts');
  const productos = await listarProductos(ctx.usuarioId, { prisma: ctx.prisma });
  if (productos.length === 0) {
    return {
      responses: ['No tenés productos cargados. Usá /nueva para empezar.'],
      newState: ctx.workingState,
      rejected: false,
    };
  }
  const lines = productos.map((p) => `${p.indice}. ${p.nombre}`);
  const lista = `Seleccioná el producto que querés editar:\n${lines.join('\n')}`;
  await ctx.conversacionRepo.update(ctx.usuarioId, {
    estado: ConversationState.AGREGANDO_STOCK,
    datosTemporales: { productosDisponibles: productos, modo: 'editar' },
  });
  return {
    responses: [lista],
    newState: ConversationState.AGREGANDO_STOCK,
    rejected: false,
  };
}

async function eliminarHandler(ctx: HandlerContext): Promise<SlashHandlerOutput> {
  const { listarProductos } = await import('../conversation/AgregarStock.ts');
  const productos = await listarProductos(ctx.usuarioId, { prisma: ctx.prisma });
  if (productos.length === 0) {
    return {
      responses: ['No tenés productos cargados. Usá /nueva para empezar.'],
      newState: ctx.workingState,
      rejected: false,
    };
  }
  const lines = productos.map((p) => `${p.indice}. ${p.nombre}`);
  const lista = `Seleccioná el producto que querés eliminar:\n${lines.join('\n')}`;
  await ctx.conversacionRepo.update(ctx.usuarioId, {
    estado: ConversationState.AGREGANDO_STOCK,
    datosTemporales: { productosDisponibles: productos, modo: 'eliminar' },
  });
  return {
    responses: [lista],
    newState: ConversationState.AGREGANDO_STOCK,
    rejected: false,
  };
}

function ayudaHandler(ctx: HandlerContext): SlashHandlerOutput {
  return {
    responses: [HELP_TEXT],
    newState: ctx.workingState,
    rejected: false,
  };
}

async function venderHandler(ctx: HandlerContext): Promise<SlashHandlerOutput> {
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

async function exportarHandler(ctx: HandlerContext): Promise<SlashHandlerOutput> {
  await ctx.exportService.exportAndSend(ctx.usuarioId, ctx.chatId);
  return {
    responses: ['📎 Excel exportado con todos los datos'],
    newState: ctx.workingState,
    rejected: false,
  };
}
