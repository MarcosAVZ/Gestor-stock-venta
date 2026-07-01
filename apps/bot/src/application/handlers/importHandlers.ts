/**
 * @compras-whatsapp/bot — importHandlers (flujo de importación Excel).
 *
 * RESPONSABILIDAD:
 * Manejar el flujo conversacional de /importar:
 * 1. handleImportarInit: inicia IMPORTANDO_ESPERANDO_ARCHIVO
 * 2. handleDocumentoRecibido: parsea Excel, muestra diff, pasa a IMPORTANDO_REVISANDO
 * 3. handleConfirmarImport: aplica cambios desde diff guardado
 * 4. handleCancelarImport: cancela importación
 *
 * Contract:
 *   importHandler(ctx) → Promise<SlashHandlerOutput>
 */

import { ConversationState } from '@compras-whatsapp/db';

import type { HandlerContext } from './HandlerContext.ts';
import type { SlashHandlerOutput } from './slashHandlers.ts';
import type { ImportDiff } from '../excel/ImportService.ts';

// ── Limits ────────────────────────────────────────────────────────────

const MAX_DIFF_LENGTH = 4000;

// ── Slash command handler ─────────────────────────────────────────────

/**
 * Handles /importar — sets state to IMPORTANDO_ESPERANDO_ARCHIVO
 * and asks the user to send an Excel file.
 */
export async function handleImportarInit(ctx: HandlerContext): Promise<SlashHandlerOutput> {
  await ctx.conversacionRepo.update(ctx.usuarioId, {
    estado: ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO,
    datosTemporales: {},
  });

  return {
    responses: ['Mandame el archivo Excel para importar'],
    newState: ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO,
    rejected: false,
  };
}

// ── Document receipt handler ──────────────────────────────────────────

/**
 * Handles an Excel document received while in IMPORTANDO_ESPERANDO_ARCHIVO.
 * Parses the file, builds a diff message, transitions to IMPORTANDO_REVISANDO.
 */
export async function handleDocumentoRecibido(
  ctx: HandlerContext,
  buffer: Buffer,
): Promise<SlashHandlerOutput> {
  const result = await ctx.importService.parse(buffer, ctx.usuarioId);

  // No valid rows at all
  if (result.diff.toCreate.length === 0 &&
      result.diff.toUpdatePrecio.length === 0 &&
      result.diff.toUpdateStock.length === 0) {
    return {
      responses: ['Ninguna fila válida para importar. Revisá el archivo e intentá de nuevo.'],
      newState: ConversationState.IMPORTANDO_ESPERANDO_ARCHIVO,
      rejected: false,
    };
  }

  // Build diff message
  const lines: string[] = ['📋 *Resumen de cambios a importar:*\n'];

  if (result.diff.toCreate.length > 0) {
    lines.push(`*${result.diff.toCreate.length} producto(s) nuevo(s):*`);
    for (const p of result.diff.toCreate) {
      lines.push(`  • ${p.nombre}: $${p.precioVenta} (stock: ${p.stock})`);
    }
    lines.push('');
  }

  if (result.diff.toUpdatePrecio.length > 0) {
    lines.push(`*${result.diff.toUpdatePrecio.length} producto(s) con cambio de precio:*`);
    for (const p of result.diff.toUpdatePrecio) {
      lines.push(`  • ${p.nombre}: $${p.oldPrecio} → $${p.precioVenta}`);
    }
    lines.push('');
  }

  if (result.diff.toUpdateStock.length > 0) {
    lines.push(`*${result.diff.toUpdateStock.length} producto(s) con cambio de stock:*`);
    for (const p of result.diff.toUpdateStock) {
      const delta = p.stock - p.oldStock;
      if (delta > 0) {
        lines.push(`  • ${p.nombre}: ${p.oldStock} → ${p.stock} (+${delta})`);
      } else {
        lines.push(`  • ${p.nombre}: ${p.oldStock} → ${p.stock} (${delta})`);
      }
    }
    lines.push('');
  }

  if (result.invalidRows.length > 0) {
    lines.push(`⚠️ *${result.invalidRows.length} fila(s) inválida(s)* ignoradas.`);
    lines.push('');
  }

  lines.push('¿Aplico estos cambios? (sí/no)');

  let message = lines.join('\n');

  // Truncate if too long
  if (message.length > MAX_DIFF_LENGTH) {
    message = `📋 *${result.diff.toCreate.length} productos nuevos, ${
      result.diff.toUpdatePrecio.length} cambios de precio, ${
      result.diff.toUpdateStock.length} cambios de stock.*\n\n`;
    if (result.invalidRows.length > 0) {
      message += `⚠️ ${result.invalidRows.length} filas inválidas ignoradas.\n\n`;
    }
    message += '¿Aplico estos cambios? (sí/no)';
  }

  // Store diff in conversation data for later confirmation
  await ctx.conversacionRepo.update(ctx.usuarioId, {
    estado: ConversationState.IMPORTANDO_REVISANDO,
    datosTemporales: { importDiff: result.diff },
  });

  return {
    responses: [message],
    newState: ConversationState.IMPORTANDO_REVISANDO,
    rejected: false,
  };
}

// ── Confirm import handler ────────────────────────────────────────────

/**
 * Handles user confirmation ("sí") in IMPORTANDO_REVISANDO.
 * Applies the stored diff and resets to PREGUNTANDO_PRODUCTO.
 */
export async function handleConfirmarImport(ctx: HandlerContext): Promise<SlashHandlerOutput> {
  const diff = ctx.workingDatos['importDiff'] as ImportDiff | undefined;

  if (!diff) {
    return {
      responses: ['No hay datos de importación para aplicar. Usá /importar de nuevo.'],
      newState: ctx.workingState,
      rejected: false,
    };
  }

  await ctx.importService.applyChanges(ctx.usuarioId, diff);

  return {
    responses: ['✅ Cambios aplicados correctamente'],
    newState: ConversationState.PREGUNTANDO_PRODUCTO,
    rejected: false,
  };
}

// ── Cancel import handler ─────────────────────────────────────────────

/**
 * Handles user cancellation ("no") in IMPORTANDO_REVISANDO.
 * Resets to PREGUNTANDO_PRODUCTO.
 */
export async function handleCancelarImport(ctx: HandlerContext): Promise<SlashHandlerOutput> {
  return {
    responses: ['Importación cancelada.'],
    newState: ConversationState.PREGUNTANDO_PRODUCTO,
    rejected: false,
  };
}
