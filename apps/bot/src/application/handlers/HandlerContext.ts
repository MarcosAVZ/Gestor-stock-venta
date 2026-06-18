/**
 * @compras-whatsapp/bot — HandlerContext (shared context for all handlers).
 *
 * Every extracted handler receives this context instead of the full
 * HandleIncomingMessageDeps. This keeps handler APIs small and explicit.
 *
 * Why a separate interface:
 * - Handlers don't need rateLimiter, whitelist, or clock (those stay in
 *   the orchestration layer).
 * - Handlers do need usuarioId + workingState + workingDatos (the
 *   conversational context they operate on).
 * - Explicit deps make handlers independently testable with mocks.
 */

import type { ConversationState } from '@compras-whatsapp/db';
import type { Logger } from 'pino';

import type { ConversacionRepository } from '../../domain/repositories/ConversacionRepository.ts';
import type { CompraRepository } from '../../domain/repositories/CompraRepository.ts';
import type { ItemCompraRepository } from '../../domain/repositories/ItemCompraRepository.ts';
import type { PrismaClientLike } from '../../infrastructure/persistence/PrismaClientLike.ts';

export interface HandlerContext {
  /** ID del usuario autenticado. */
  usuarioId: string;
  /** Estado actual de la conversación. */
  workingState: ConversationState;
  /** Datos temporales de la conversación (producto, cantidad, etc.). */
  workingDatos: Record<string, unknown>;
  /** Repositorio de conversaciones (para persistir cambios de estado). */
  conversacionRepo: ConversacionRepository;
  /** Repositorio de compras (para crear nuevas compras). */
  compraRepo: CompraRepository;
  /** Repositorio de items de compra (para CRUD de items). */
  itemCompraRepo: ItemCompraRepository;
  /** Prisma client para queries de listarProductos. */
  prisma: PrismaClientLike;
  /** Logger estructurado (pino). */
  logger: Logger;
}
