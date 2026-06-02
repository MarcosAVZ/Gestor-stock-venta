/**
 * Puerto (interface) del repositorio de Conversacion.
 *
 * La Conversacion es la fuente de verdad del state machine: persistimos
 * `estado` + `datosTemporales` para que el bot sobreviva reinicios. La
 * PK lógica es `usuarioId` (UNIQUE), por eso la firma principal es
 * `findByUsuarioId`.
 *
 * El método `update` está pensado para transiciones de estado y patch
 * de `datosTemporales`; `upsert` se usa cuando llega el primer mensaje
 * de un usuario y aún no hay conversación.
 */

import type { Conversacion, ConversationState } from '@compras-whatsapp/db';

/** Tipo del JSON `datosTemporales`. La forma varía por estado. */
export type DatosTemporales = Record<string, unknown>;

export interface ConversacionRepository {
  /**
   * Busca la conversación activa de un usuario. Devuelve `null` si
   * nunca interactuó con el bot.
   */
  findByUsuarioId(usuarioId: string): Promise<Conversacion | null>;

  /**
   * Crea o actualiza la conversación de un usuario atómicamente.
   * Útil cuando llega el primer mensaje (no sabemos si existe).
   */
  upsert(data: {
    usuarioId: string;
    estado?: ConversationState;
    datosTemporales?: DatosTemporales;
  }): Promise<Conversacion>;

  /**
   * Actualiza estado y/o datosTemporales de la conversación de un
   * usuario. Lanza `NotFoundError` si la conversación no existe
   * (no la crea — el caller debe decidir si upsert es lo correcto).
   */
  update(
    usuarioId: string,
    patch: {
      estado?: ConversationState;
      datosTemporales?: DatosTemporales;
    },
  ): Promise<Conversacion>;
}
