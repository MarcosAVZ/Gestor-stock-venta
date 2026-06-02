/**
 * Adapter Prisma para `ConversacionRepository`.
 *
 * Decisiones:
 * - `upsert` con `where: { usuarioId }` (la unique constraint).
 * - `update` propaga `NotFoundError` cuando la conversación no existe
 *   (P2025 de Prisma). Lo convertimos manualmente porque la interface
 *   lo promete como OperationalError, no como ProgrammerError.
 */

import { prisma } from '@compras-whatsapp/db';
import { Prisma } from '@compras-whatsapp/db';
import { ConversationState } from '@compras-whatsapp/db';
import type { Conversacion } from '@compras-whatsapp/db';

import { NotFoundError } from '../../domain/errors/OperationalError.ts';
import type {
  ConversacionRepository,
  DatosTemporales,
} from '../../domain/repositories/ConversacionRepository.ts';
import type { PrismaClientLike } from './PrismaClientLike.ts';

export class PrismaConversacionRepository implements ConversacionRepository {
  constructor(private readonly db: PrismaClientLike = prisma as unknown as PrismaClientLike) {}

  async findByUsuarioId(usuarioId: string): Promise<Conversacion | null> {
    return (await this.db.conversacion.findUnique({
      where: { usuarioId },
    })) as Conversacion | null;
  }

  async upsert(data: {
    usuarioId: string;
    estado?: ConversationState;
    datosTemporales?: DatosTemporales;
  }): Promise<Conversacion> {
    return (await this.db.conversacion.upsert({
      where: { usuarioId: data.usuarioId },
      create: {
        usuarioId: data.usuarioId,
        estado: data.estado ?? ConversationState.ESPERANDO_IMAGEN,
        datosTemporales: (data.datosTemporales ?? {}) as unknown as Prisma.InputJsonValue,
      },
      update: {
        ...(data.estado !== undefined && { estado: data.estado }),
        ...(data.datosTemporales !== undefined && {
          datosTemporales: data.datosTemporales as unknown as Prisma.InputJsonValue,
        }),
      },
    })) as Conversacion;
  }

  async update(
    usuarioId: string,
    patch: { estado?: ConversationState; datosTemporales?: DatosTemporales },
  ): Promise<Conversacion> {
    const data: { estado?: ConversationState; datosTemporales?: Prisma.InputJsonValue } = {};
    if (patch.estado !== undefined) data.estado = patch.estado;
    if (patch.datosTemporales !== undefined) {
      data.datosTemporales = patch.datosTemporales as unknown as Prisma.InputJsonValue;
    }
    try {
      return (await this.db.conversacion.update({
        where: { usuarioId },
        data,
      })) as Conversacion;
    } catch (err: unknown) {
      // P2025 = "Record to update not found."
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundError('Conversacion', usuarioId, { cause: err });
      }
      throw err;
    }
  }
}
